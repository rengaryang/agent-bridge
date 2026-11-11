import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { record, publish } from "../core/util.js";
import type { WorkerRequest, WorkerResult } from "./types.js";
const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const target = process.argv[2];
const input = await new Promise<string>((resolve, reject) => {
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => {
    text += d;
    if (Buffer.byteLength(text) > 32 * 1024 * 1024)
      reject(new Error("Worker request too large"));
  });
  process.stdin.on("end", () => resolve(text));
  process.stdin.on("error", reject);
});
const request: WorkerRequest = JSON.parse(input);
async function main(): Promise<WorkerResult> {
  if (!["pi", "omp"].includes(String(target)))
    throw new Error("Unsupported native worker target");
  const root = await fs.realpath(request.root);
  const cwd = await fs.realpath(request.cwd);
  if (root !== path.resolve(request.root))
    throw new Error("Worker root must be canonical");
  const file = request.sessionFile;
  if (file) {
    const canonical = await fs.realpath(file);
    if (
      canonical !== path.resolve(file) ||
      path.dirname(canonical) !== path.join(root, "sessions")
    )
      throw new Error("Native session outside owned session directory");
  }
  const pkg =
    target === "pi"
      ? "@earendil-works/pi-coding-agent"
      : "@oh-my-pi/pi-coding-agent";
  const base = path.join(project, "runtimes", target!, "node_modules", pkg);
  const version = JSON.parse(
    await fs.readFile(path.join(base, "package.json"), "utf8"),
  ).version;
  if (version !== (target === "pi" ? "1.5.1" : "18.16.0"))
    throw new Error("Native SDK version mismatch");
  const source =
    target === "pi"
      ? "dist/core/session-manager.js"
      : "src/session/session-manager.ts";
  const { SessionManager } = await import(
    pathToFileURL(path.join(base, source)).href
  );
  let manager: any;
  const mapping: WorkerResult["mapping"] = [];
  if (request.operation === "create") {
    if (!request.messages?.length) throw new Error("Native messages required");
    manager = SessionManager.create(cwd, path.join(root, "sessions"));
    for (const message of request.messages) {
      let id: string;
      if (message.role === "custom")
        id = manager.appendCustomMessageEntry(
          "agent-bridge.historical",
          message.text,
          true,
          { sourceEventId: message.sourceEventId },
        );
      else if (message.role === "user")
        id = manager.appendMessage({
          role: "user",
          content: message.text,
          timestamp: Date.now(),
        });
      else {
        const meta = message.metadata ?? {};
        // Required native usage fields are placeholders only when historical measurement is unavailable.
        const usage =
          record(meta.usage) &&
          typeof meta.usage.input === "number" &&
          typeof meta.usage.output === "number"
            ? meta.usage
            : {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              };
        id = manager.appendMessage({
          role: "assistant",
          content: [{ type: "text", text: message.text }],
          api: typeof meta.api === "string" ? meta.api : "openai-responses",
          provider:
            typeof meta.provider === "string"
              ? meta.provider
              : "imported-history",
          model:
            typeof meta.model === "string" ? meta.model : "imported-history",
          usage,
          stopReason: "stop",
          timestamp:
            typeof meta.timestamp === "number" ? meta.timestamp : Date.now(),
        });
      }
      mapping.push({ sourceEventId: message.sourceEventId, targetEntryId: id });
    }
    manager.appendCustomEntry("agent-bridge.migration", {
      version: 1,
      sourceMap: mapping,
      toolProtocol: "inert",
      usageUnknown:
        "Zero-shaped fields, if present, are schema placeholders, not measured usage.",
    });
    if (target === "omp") {
      await manager.ensureOnDisk();
      await manager.flush();
    } else {
      // Pi 1.5.1 lazily persists custom-only sessions. Publish SDK-generated header/entries
      // exclusively, then reopen via the native API; never add a fake user/assistant turn.
      const sessionFile = manager.getSessionFile();
      try {
        await fs.access(sessionFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const lines =
          [manager.getHeader(), ...manager.getEntries()]
            .map((e) => JSON.stringify(e))
            .join("\n") + "\n";
        await publish(sessionFile, lines);
        manager = SessionManager.open(sessionFile, path.join(root, "sessions"));
      }
    }
  } else {
    if (!file) throw new Error("Session file required");
    manager =
      target === "pi"
        ? SessionManager.open(file, path.join(root, "sessions"))
        : await SessionManager.open(
            file,
            path.join(root, "sessions"),
            undefined,
            { initialCwd: cwd, suppressBreadcrumb: true, throwIfMissing: true },
          );
    if (request.operation === "append-test-user") {
      if (!request.text) throw new Error("Synthetic user text required");
      manager.appendMessage({
        role: "user",
        content: request.text,
        timestamp: Date.now(),
      });
      if (target === "omp") await manager.flush();
    } else if (request.operation !== "inspect")
      throw new Error("Unsupported worker operation");
  }
  try {
    const context = manager.buildSessionContext().messages.map((m: any) => ({
      role: m.role,
      text:
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content
                .filter((x: any) => x.type === "text")
                .map((x: any) => x.text)
                .join("\n")
            : "",
    }));
    const result: WorkerResult = {
      sessionFile: manager.getSessionFile(),
      sessionId: manager.getSessionId(),
      cwd: manager.getCwd(),
      context,
      entryIds: manager.getEntries().map((e: any) => e.id),
      mapping,
      sdkVersion: version,
    };
    return result;
  } finally {
    if (target === "omp") await manager.close();
  }
}
main()
  .then((result) => process.stdout.write(JSON.stringify({ result }) + "\n"))
  .catch((error) => {
    process.stderr.write(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Worker failed",
      }) + "\n",
    );
    process.exitCode = 1;
  });
