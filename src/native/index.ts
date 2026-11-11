import { mkdir, readFile, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { decodeBundle } from "../core/bundle.js";
import { sha256, ensureDirectory, publish, record } from "../core/util.js";
import { compileNative } from "./compiler.js";
import { runNativeWorker } from "./runner.js";
import type { NativeAgent, NativeReceipt } from "./types.js";
import type { AgentName } from "../core/types.js";
export { compileNative, runNativeWorker };
export async function planNative(
  bytes: Uint8Array,
  options: { to: AgentName; cwd: string },
) {
  if (options.to === "codex")
    throw new Error(
      "Codex structured import remains unsupported; use explicit handoff.",
    );
  const s = decodeBundle(bytes);
  const compiled = compileNative(s);
  return {
    mode: "structured",
    target: options.to,
    cwd: await realpath(await ensureDirectory(options.cwd)),
    sdkVersion: options.to === "pi" ? "1.5.1" : "18.16.0",
    plannedStatus: "NATIVE_CONTEXT_VERIFIED",
    nativeContextMessages: compiled.messages.length,
    losses: compiled.losses,
    modelInvocation: false,
    interactiveCliVerified: false,
    contextWindowChecked: false,
  };
}

export async function importNative(
  bytes: Uint8Array,
  options: { to: AgentName; cwd: string; out: string },
): Promise<{ directory: string; receipt: NativeReceipt; reused: boolean }> {
  if (options.to === "codex")
    throw new Error(
      "Codex structured import is not supported; experimental history is cloud-only. Use handoff.",
    );
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error(
      "Native import currently requires macOS arm64 isolation/runtime",
    );
  const s = decodeBundle(bytes);
  const compiled = compileNative(s);
  const cwd = await realpath(await ensureDirectory(options.cwd));
  const out = await realpath(await ensureDirectory(options.out));
  const key = sha256(
    JSON.stringify({
      compiler: "native-v1",
      sdk: options.to === "pi" ? "1.5.1" : "18.16.0",
      bundle: sha256(bytes),
      to: options.to,
      cwd,
      messages: compiled.messages,
    }),
  );
  const directory = path.join(out, `native-${key.slice(0, 20)}`);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const verified = await verifyNative(directory);
    if (verified.receipt.idempotencyKey !== key)
      throw new Error("Native identity conflict");
    return { directory, receipt: verified.receipt, reused: true };
  }
  await publish(path.join(directory, "source.acx"), bytes);
  await publish(
    path.join(directory, "compilation.json"),
    JSON.stringify(compiled, null, 2),
  );
  await mkdir(path.join(directory, "sessions"), { mode: 0o700 });
  const created = await runNativeWorker(options.to, {
    operation: "create",
    root: directory,
    cwd,
    messages: compiled.messages,
  });
  if (created.sessionId === s.source.sessionId)
    throw new Error("Target native identity must be new");
  const cold = await runNativeWorker(options.to, {
    operation: "inspect",
    root: directory,
    cwd,
    sessionFile: created.sessionFile,
  });
  if (
    JSON.stringify(created.context) !== JSON.stringify(cold.context) ||
    cold.cwd !== cwd ||
    created.sessionId !== cold.sessionId
  )
    throw new Error("Native cold context mismatch");
  const compiledContext = compiled.messages.map((m) => ({
    role: m.role,
    text: m.text,
  }));
  if (JSON.stringify(compiledContext) !== JSON.stringify(cold.context))
    throw new Error("SDK context does not match native compiler");
  const sessionBytes = await readFile(created.sessionFile);
  const receipt: NativeReceipt = {
    schemaVersion: 2,
    status: "NATIVE_CONTEXT_VERIFIED",
    mode: "structured",
    target: options.to,
    idempotencyKey: key,
    cwd,
    nativeSessionId: created.sessionId,
    sessionFile: created.sessionFile,
    sdkVersion: created.sdkVersion,
    importedContext: cold.context,
    mapping: created.mapping,
    losses: compiled.losses,
    files: [
      { path: "source.acx", sha256: sha256(bytes), size: bytes.length },
      {
        path: "compilation.json",
        sha256: sha256(
          await readFile(path.join(directory, "compilation.json")),
        ),
        size: (await lstat(path.join(directory, "compilation.json"))).size,
      },
      {
        path: path.relative(directory, created.sessionFile),
        sha256: sha256(sessionBytes),
        size: sessionBytes.length,
      },
    ],
    verification: {
      storageColdRestore: true,
      contextProjection: true,
      modelInvocation: false,
      toolExecution: false,
      interactiveCli: false,
    },
    resume: {
      command: options.to,
      args: [
        options.to === "pi" ? "--session" : "--resume",
        created.sessionFile,
        "--session-dir",
        path.dirname(created.sessionFile),
        "--no-context-files",
        "--no-extensions",
        "--no-skills",
        "--no-tools",
      ],
      automatic: false,
    },
  };
  await publish(
    path.join(directory, "receipt.json"),
    JSON.stringify(receipt, null, 2),
  );
  return { directory, receipt, reused: false };
}
export async function verifyNative(dir: string): Promise<{
  receipt: NativeReceipt;
  contextPrefixIntact: true;
  additionalMessages: number;
}> {
  const root = await realpath(dir);
  if (root !== path.resolve(dir) || (await lstat(dir)).isSymbolicLink())
    throw new Error("Unsafe native directory");
  const receiptFile = path.join(root, "receipt.json");
  const st = await lstat(receiptFile);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 32 * 1024 * 1024)
    throw new Error("Unsafe native receipt");
  const value: unknown = JSON.parse(await readFile(receiptFile, "utf8"));
  if (
    !record(value) ||
    value.schemaVersion !== 2 ||
    value.status !== "NATIVE_CONTEXT_VERIFIED" ||
    !["pi", "omp"].includes(String(value.target)) ||
    typeof value.sessionFile !== "string" ||
    typeof value.cwd !== "string" ||
    typeof value.idempotencyKey !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.idempotencyKey) ||
    !Array.isArray(value.files) ||
    value.files.length !== 3 ||
    !Array.isArray(value.importedContext) ||
    !record(value.verification) ||
    value.verification.modelInvocation !== false ||
    value.verification.toolExecution !== false ||
    value.verification.storageColdRestore !== true ||
    !record(value.resume) ||
    value.resume.automatic !== false
  )
    throw new Error("Invalid native receipt");
  const receipt = value as unknown as NativeReceipt;
  const sessionReal = await realpath(receipt.sessionFile);
  if (
    sessionReal !== receipt.sessionFile ||
    path.dirname(sessionReal) !== path.join(root, "sessions")
  )
    throw new Error("Session outside native directory");
  const seen = new Set<string>();
  let prefixSize = 0;
  for (const f of receipt.files) {
    if (
      !record(f) ||
      typeof f.path !== "string" ||
      ![
        "source.acx",
        "compilation.json",
        path.relative(root, sessionReal),
      ].includes(f.path) ||
      seen.has(f.path) ||
      typeof f.size !== "number" ||
      !Number.isSafeInteger(f.size) ||
      f.size < 0 ||
      f.size > 64 * 1024 * 1024 ||
      typeof f.sha256 !== "string"
    )
      throw new Error("Invalid native member");
    seen.add(f.path);
    const fp = path.join(root, f.path);
    const fst = await lstat(fp);
    if (
      !fst.isFile() ||
      fst.isSymbolicLink() ||
      fst.size > 64 * 1024 * 1024 ||
      (await realpath(fp)) !== fp
    )
      throw new Error("Unsafe native member");
    const data = await readFile(fp);
    const native = fp === sessionReal;
    const relevant = native ? data.subarray(0, f.size) : data;
    if (relevant.length !== f.size || sha256(relevant) !== f.sha256)
      throw new Error("Native member integrity mismatch");
    if (native) prefixSize = f.size;
  }
  if (
    !seen.has("source.acx") ||
    !seen.has("compilation.json") ||
    prefixSize === 0
  )
    throw new Error("Native members missing");
  const source = decodeBundle(await readFile(path.join(root, "source.acx")));
  const computedKey = sha256(
    JSON.stringify({
      compiler: "native-v1",
      sdk: receipt.target === "pi" ? "1.5.1" : "18.16.0",
      bundle: sha256(await readFile(path.join(root, "source.acx"))),
      to: receipt.target,
      cwd: receipt.cwd,
      messages: compileNative(source).messages,
    }),
  );
  if (computedKey !== receipt.idempotencyKey)
    throw new Error("Native idempotency key mismatch");
  const compiled = compileNative(source);
  if (
    JSON.stringify(compiled) !==
    JSON.stringify(
      JSON.parse(await readFile(path.join(root, "compilation.json"), "utf8")),
    )
  )
    throw new Error("Native compilation/source mismatch");
  const expected = compiled.messages.map((m) => ({
    role: m.role,
    text: m.text,
  }));
  if (JSON.stringify(expected) !== JSON.stringify(receipt.importedContext))
    throw new Error("Native receipt/source context mismatch");
  const cold = await runNativeWorker(receipt.target, {
    operation: "inspect",
    root,
    cwd: receipt.cwd,
    sessionFile: sessionReal,
  });
  if (
    cold.sdkVersion !== receipt.sdkVersion ||
    cold.cwd !== receipt.cwd ||
    cold.sessionId !== receipt.nativeSessionId ||
    JSON.stringify(cold.context.slice(0, expected.length)) !==
      JSON.stringify(expected)
  )
    throw new Error("Native cold context mismatch");
  if (
    !Array.isArray(receipt.mapping) ||
    receipt.mapping.length !== compiled.messages.length
  )
    throw new Error("Native source map missing");
  const entrySet = new Set(cold.entryIds);
  const mapped = new Set<string>();
  for (const [index, m] of receipt.mapping.entries()) {
    if (
      !record(m) ||
      m.sourceEventId !== compiled.messages[index]!.sourceEventId ||
      typeof m.targetEntryId !== "string" ||
      !entrySet.has(m.targetEntryId) ||
      mapped.has(m.targetEntryId)
    )
      throw new Error("Native source map mismatch");
    mapped.add(m.targetEntryId);
  }
  return {
    receipt,
    contextPrefixIntact: true,
    additionalMessages: cold.context.length - expected.length,
  };
}
