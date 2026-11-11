#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import { encodeBundle, decodeBundle } from "./core/bundle.js";
import { assertCheckpoint } from "./core/checkpoint.js";
async function explicitCheckpoint(file?: string): Promise<unknown> {
  if (!file) return undefined;
  const s = await lstat(file);
  if (!s.isFile() || s.size > 256 * 1024)
    throw new Error("Checkpoint must be a JSON file under 256 KiB");
  const value: unknown = JSON.parse(await readFile(file, "utf8"));
  assertCheckpoint(value);
  return value;
}
function transferProfile(
  value?: string,
): "archive" | "context-only" | undefined {
  if (value === undefined) return undefined;
  if (value !== "archive" && value !== "context-only")
    throw new Error("Profile must be archive or context-only");
  return value;
}
async function inputBundle(
  file: string,
  o: Record<string, string>,
): Promise<Uint8Array> {
  const bytes = await readBundleFile(file);
  const profile = transferProfile(o.profile);
  if (o.checkpoint && profile !== "context-only")
    throw new Error("--checkpoint requires --profile context-only");
  if (profile === "context-only")
    return encodeBundle(decodeBundle(bytes), {
      profile,
      checkpoint: await explicitCheckpoint(o.checkpoint),
    });
  if (
    profile === "archive" &&
    decodeBundle(bytes).security.profile === "context-only"
  )
    throw new Error("Excluded history cannot be restored to archive");
  return bytes;
}
import { readSnapshot } from "./core/snapshot.js";
import {
  planMigration,
  installPrepared,
  verifyPrepared,
  readBundleFile,
} from "./core/migration.js";
import { agent, publish, ensureDirectory, positiveInt } from "./core/util.js";
import { probeAgents } from "./core/probe.js";
import { importNative, verifyNative, planNative } from "./native/index.js";
import { readFile, lstat } from "node:fs/promises";
async function receiptVersion(dir: string): Promise<number> {
  const file = path.join(path.resolve(dir), "receipt.json");
  const s = await lstat(file);
  if (!s.isFile() || s.isSymbolicLink() || s.size > 32 * 1024 * 1024)
    throw new Error("Unsafe receipt");
  const v: unknown = JSON.parse(await readFile(file, "utf8"));
  if (
    !v ||
    typeof v !== "object" ||
    !("schemaVersion" in v) ||
    ![1, 2].includes(Number(v.schemaVersion))
  )
    throw new Error("Unknown receipt version");
  return Number(v.schemaVersion);
}
import type { MigrationOptions } from "./core/types.js";
const cli = new Command()
  .name("abridge")
  .description(
    "Local-first agent session migration preview; never executes historical tools",
  )
  .version("0.3.0");
const print = (v: unknown): void => {
  process.stdout.write(JSON.stringify(v, null, 2) + "\n");
};
cli
  .command("agents")
  .description("Read-only binary capability probe")
  .action(async () => print(await probeAgents()));
cli
  .command("export")
  .requiredOption("--from <agent>")
  .requiredOption("--session <path>")
  .requiredOption("--out <path>")
  .option("--leaf <id>")
  .option("--profile <profile>", "archive|context-only", "archive")
  .option(
    "--checkpoint <json>",
    "Explicit semantic checkpoint; context-only only",
  )
  .action(async (o) => {
    const s = await readSnapshot(agent(o.from), o.session, o.leaf);
    const bytes = encodeBundle(s, {
      profile: transferProfile(o.profile),
      checkpoint: await explicitCheckpoint(o.checkpoint),
    });
    await publish(o.out, bytes);
    const exported = decodeBundle(bytes);
    print({
      path: path.resolve(o.out),
      status:
        exported.security.profile === "context-only"
          ? "CHECKPOINT_EXPORTED"
          : "ARCHIVED",
      profile: exported.security.profile,
      events: exported.events.length,
      issues: exported.issues,
    });
  });
cli
  .command("inspect")
  .argument("<bundle>")
  .action(async (file) => {
    const s = decodeBundle(await readBundleFile(file));
    print({
      source: s.source,
      title: s.title,
      cwd: s.cwd,
      selectedLeaf: s.selectedLeaf,
      events: s.events.length,
      contextMessages: s.context.length,
      pendingTools: s.pendingTools,
      issues: s.issues,
      security: s.security,
      ...(s.checkpoint ? { checkpoint: s.checkpoint } : {}),
    });
  });
function opts(o: Record<string, string>): MigrationOptions {
  return {
    to: agent(o.to!),
    cwd: o.cwd!,
    mode: (o.mode ?? "auto") as MigrationOptions["mode"],
    budget: positiveInt(o.budget ?? 12000),
  };
}
function common(cmd: Command): Command {
  return cmd
    .requiredOption("--to <agent>")
    .requiredOption("--cwd <path>")
    .option("--mode <mode>", "auto|handoff|structured", "auto")
    .option("--budget <tokens>", "estimated import token budget", "12000")
    .option(
      "--profile <profile>",
      "archive|context-only; omitted preserves input profile",
    )
    .option("--checkpoint <json>", "Explicit checkpoint; context-only only");
}
common(cli.command("plan").argument("<bundle>")).action(async (file, o) => {
  await ensureDirectory(o.cwd);
  const bytes = await inputBundle(file, o);
  print(
    o.mode === "structured"
      ? await planNative(bytes, { to: agent(o.to), cwd: o.cwd })
      : planMigration(decodeBundle(bytes), opts(o)),
  );
});
common(cli.command("import").argument("<bundle>"))
  .requiredOption("--out <directory>")
  .action(async (file, o) => {
    const bytes = await inputBundle(file, o);
    print(
      o.mode === "structured"
        ? await importNative(bytes, { to: agent(o.to), cwd: o.cwd, out: o.out })
        : await installPrepared(
            planMigration(decodeBundle(bytes), opts(o)),
            o.out,
            bytes,
          ),
    );
  });
common(cli.command("migrate"))
  .requiredOption("--from <agent>")
  .requiredOption("--session <path>")
  .requiredOption("--out <directory>")
  .option("--leaf <id>")
  .action(async (o) => {
    const bytes = encodeBundle(
      await readSnapshot(agent(o.from), o.session, o.leaf),
      {
        profile: transferProfile(o.profile) ?? "archive",
        checkpoint: await explicitCheckpoint(o.checkpoint),
      },
    );
    const session = decodeBundle(bytes);
    print(
      o.mode === "structured"
        ? await importNative(bytes, { to: agent(o.to), cwd: o.cwd, out: o.out })
        : await installPrepared(planMigration(session, opts(o)), o.out, bytes),
    );
  });
cli
  .command("verify")
  .argument("<prepared-directory>")
  .action(async (dir) => {
    const version = await receiptVersion(dir);
    print(
      version === 2
        ? await verifyNative(dir)
        : {
            receipt: await verifyPrepared(dir),
            preparedIntegrityVerified: true,
            nativeResumeVerified: false,
          },
    );
  });
cli
  .command("resume")
  .argument("<prepared-directory>")
  .description("Show manual handoff instructions; does not launch target")
  .action(async (dir) => {
    const version = await receiptVersion(dir);
    if (version === 2) {
      const { receipt: r } = await verifyNative(dir);
      print({
        status: r.status,
        cwd: r.cwd,
        command: r.target,
        args: [
          r.target === "pi" ? "--session" : "--resume",
          r.sessionFile,
          "--session-dir",
          path.dirname(r.sessionFile),
          "--no-extensions",
          "--no-skills",
          "--no-tools",
          "--no-context-files",
        ],
        automatic: false,
        storageColdRestoreVerified: true,
        modelContinuationVerified: false,
        instructions:
          "Use a compatible pinned target agent and select an available model explicitly. Tool history is inert; tool activation requires an explicit later decision.",
      });
      return;
    }
    const r = await verifyPrepared(dir);
    print({
      status: r.status,
      cwd: r.cwd,
      command: r.resume.command,
      args: r.resume.args,
      handoff: path.join(path.resolve(dir), "handoff.md"),
      instructions: r.resume.instructions,
      automatic: false,
      nativeResumeVerified: false,
    });
  });
cli.parseAsync().catch((error) => {
  process.stderr.write(
    JSON.stringify({
      error: error instanceof Error ? error.message : "Unknown error",
    }) + "\n",
  );
  process.exitCode = 1;
});
