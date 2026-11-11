import { readFile, stat, mkdir, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  CanonicalSession,
  MigrationOptions,
  MigrationPlan,
  Receipt,
} from "./types.js";
import { compileHandoff } from "./handoff.js";
import { sha256, publish, ensureDirectory, record, agent } from "./util.js";
import { assertSession } from "./validation.js";
export function planMigration(
  session: CanonicalSession,
  options: MigrationOptions,
): MigrationPlan {
  assertSession(session);
  if (options.mode === "structured")
    throw new Error(
      "Structured import is not implemented or verified in preview; use explicit handoff mode",
    );
  if (!["auto", "handoff"].includes(options.mode))
    throw new Error("Unsupported migration mode");
  if (session.issues.some((i) => i.severity === "error"))
    throw new Error(
      "Migration blocked by semantic/resource errors; inspect the completeness report",
    );
  const handoff = compileHandoff(session, options.budget ?? 12000);
  const cwd = path.resolve(options.cwd);
  const key = sha256(
    JSON.stringify({
      version: 1,
      adapter: "prepared-v1",
      to: options.to,
      cwd,
      leaf: session.selectedLeaf,
      source: session.source.digest,
      context: session.context,
      budget: options.budget ?? 12000,
      mode: "handoff",
    }),
  );
  return {
    schemaVersion: 1,
    status: "PREPARED",
    target: options.to,
    cwd,
    mode: "handoff",
    nativeResumeVerified: false,
    sourceDigest: session.source.digest,
    idempotencyKey: key,
    handoff,
    issues: [
      ...session.issues,
      ...(handoff.omitted.length
        ? [
            {
              severity: "warning" as const,
              code: "CONTEXT_BUDGET_OMISSION",
              message: `${handoff.omitted.length} messages omitted from handoff; retained in archive.`,
            },
          ]
        : []),
    ],
  };
}
export async function installPrepared(
  plan: MigrationPlan,
  out: string,
  bundle?: Uint8Array,
): Promise<{ directory: string; receipt: Receipt; reused: boolean }> {
  await ensureDirectory(plan.cwd);
  const base = await ensureDirectory(out);
  const directory = path.join(base, plan.idempotencyKey.slice(0, 24));
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const receipt = await verifyPrepared(directory);
    if (receipt.idempotencyKey !== plan.idempotencyKey)
      throw new Error("Prepared directory identity conflict");
    return { directory, receipt, reused: true };
  }
  // If interrupted, the directory remains incomplete and later verification fails closed.
  const artifacts: { path: string; data: string | Uint8Array }[] = [
    { path: "handoff.md", data: plan.handoff.text },
    { path: "plan.json", data: JSON.stringify(plan, null, 2) },
    ...(bundle ? [{ path: "source.acx", data: bundle }] : []),
  ];
  for (const artifact of artifacts)
    await publish(path.join(directory, artifact.path), artifact.data);
  const receipt: Receipt = {
    schemaVersion: 1,
    status: "PREPARED",
    idempotencyKey: plan.idempotencyKey,
    target: plan.target,
    cwd: plan.cwd,
    nativeResumeVerified: false,
    handoffSha256: sha256(plan.handoff.text),
    files: artifacts.map((x) => ({
      path: x.path,
      sha256: sha256(x.data),
      size: Buffer.byteLength(x.data),
    })),
    resume: {
      command: plan.target,
      args: [],
      automatic: false,
      instructions:
        "Start the target agent in cwd, then submit handoff.md as historical context together with your next request. This is not native history recovery.",
    },
  };
  await publish(
    path.join(directory, "receipt.json"),
    JSON.stringify(receipt, null, 2),
  );
  return { directory, receipt, reused: false };
}
export async function verifyPrepared(directory: string): Promise<Receipt> {
  const root = path.resolve(directory);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error("Unsafe prepared directory");
  const rp = path.join(root, "receipt.json");
  const rstat = await lstat(rp);
  if (!rstat.isFile() || rstat.isSymbolicLink() || rstat.size > 1024 * 1024)
    throw new Error("Unsafe receipt");
  const r: unknown = JSON.parse(await readFile(rp, "utf8"));
  if (
    !record(r) ||
    r.schemaVersion !== 1 ||
    r.status !== "PREPARED" ||
    r.nativeResumeVerified !== false ||
    typeof r.idempotencyKey !== "string" ||
    !/^[a-f0-9]{64}$/.test(r.idempotencyKey) ||
    typeof r.target !== "string" ||
    typeof r.cwd !== "string" ||
    !path.isAbsolute(r.cwd) ||
    !Array.isArray(r.files) ||
    ![2, 3].includes(r.files.length) ||
    !record(r.resume) ||
    r.resume.automatic !== false ||
    r.resume.command !== r.target ||
    !Array.isArray(r.resume.args) ||
    r.resume.args.length !== 0
  )
    throw new Error("Invalid receipt");
  agent(r.target);
  const seen = new Set<string>();
  for (const f of r.files) {
    if (
      !record(f) ||
      !["handoff.md", "plan.json", "source.acx"].includes(String(f.path)) ||
      typeof f.path !== "string" ||
      seen.has(f.path) ||
      typeof f.sha256 !== "string" ||
      typeof f.size !== "number"
    )
      throw new Error("Unsafe receipt member");
    seen.add(f.path);
    const fp = path.join(root, f.path);
    const st = await lstat(fp);
    if (
      !st.isFile() ||
      st.isSymbolicLink() ||
      st.size > (f.path === "source.acx" ? 64 : 32) * 1024 * 1024 ||
      (await realpath(path.dirname(fp))) !== (await realpath(root))
    )
      throw new Error("Unsafe prepared member");
    const data = await readFile(fp);
    if (data.length !== f.size || sha256(data) !== f.sha256)
      throw new Error("Prepared member integrity mismatch");
  }
  if (!seen.has("handoff.md") || !seen.has("plan.json"))
    throw new Error("Missing prepared members");
  const plan: unknown = JSON.parse(
    await readFile(path.join(root, "plan.json"), "utf8"),
  );
  if (
    !record(plan) ||
    plan.idempotencyKey !== r.idempotencyKey ||
    plan.target !== r.target ||
    plan.cwd !== r.cwd ||
    plan.status !== "PREPARED" ||
    plan.nativeResumeVerified !== false
  )
    throw new Error("Receipt/plan disagree");
  if (sha256(await readFile(path.join(root, "handoff.md"))) !== r.handoffSha256)
    throw new Error("Handoff checksum mismatch");
  return r as unknown as Receipt;
}
export async function readBundleFile(file: string): Promise<Uint8Array> {
  const st = await stat(file);
  if (!st.isFile() || st.size > 64 * 1024 * 1024)
    throw new Error("Invalid bundle file size");
  return readFile(file);
}
