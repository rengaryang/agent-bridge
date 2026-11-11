import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, realpath, access } from "node:fs/promises";
import path from "node:path";
import type { NativeAgent, WorkerRequest, WorkerResult } from "./types.js";
import { record } from "../core/util.js";
const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export async function runNativeWorker(
  target: NativeAgent,
  request: WorkerRequest,
): Promise<WorkerResult> {
  if (!["pi", "omp"].includes(target))
    throw new Error("Unsupported native worker");
  if (process.platform !== "darwin")
    throw new Error(
      "Native worker OS isolation is currently supported on macOS only",
    );
  const root = await realpath(request.root);
  if (root !== path.resolve(request.root))
    throw new Error("Native root must not be a symlink");
  const isolation = path.join(root, "isolation");
  const home = path.join(isolation, "home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  if (
    (await realpath(home)) !== home ||
    (await realpath(isolation)) !== isolation
  )
    throw new Error("Unsafe native isolation symlink");
  const binary =
    target === "pi"
      ? process.execPath
      : path.join(
          project,
          "runtimes/omp/node_modules/@oven/bun-darwin-aarch64/bin/bun",
        );
  const script = path.join(project, "dist/native/worker-runtime.js");
  await access(binary);
  await access(script);
  // This runner invokes only pinned storage modules; no AgentSession, model, extensions or tool implementations.
  // OS denies all network and all writes outside this owned staging root (and /dev/null).
  const profile = `(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (subpath ${JSON.stringify(root)}) (literal "/dev/null"))`;
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    HOME: home,
    TMPDIR: isolation,
    LANG: "en_US.UTF-8",
    XDG_CONFIG_HOME: path.join(isolation, "config"),
    XDG_CACHE_HOME: path.join(isolation, "cache"),
    XDG_STATE_HOME: path.join(isolation, "state"),
    XDG_DATA_HOME: path.join(isolation, "data"),
    PI_CODING_AGENT_DIR: path.join(isolation, "agent"),
    BUN_CONFIG_NO_CLEAR_TERMINAL: "1",
    DO_NOT_TRACK: "1",
    PI_OFFLINE: "1",
  };
  const runtimeArgs =
    target === "omp"
      ? [
          "--no-env-file",
          "--no-install",
          "--no-macros",
          "--config=/dev/null",
          script,
          target,
        ]
      : [script, target];
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "/usr/bin/sandbox-exec",
      ["-p", profile, binary, ...runtimeArgs],
      { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] },
    );
    let out = "",
      err = "";
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.kill("SIGKILL");
      reject(error);
    };
    const timer = setTimeout(
      () =>
        fail(new Error("Native worker timed out; verify staging before retry")),
      30000,
    );
    proc.stdout.on("data", (d) => {
      out += String(d);
      if (Buffer.byteLength(out) > 32 * 1024 * 1024)
        fail(new Error("Worker output too large"));
    });
    proc.stderr.on("data", (d) => {
      err += String(d);
      if (Buffer.byteLength(err) > 65536)
        fail(new Error("Worker diagnostic too large"));
    });
    proc.on("error", fail);
    proc.stdin.on("error", fail);
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(`Native worker failed (${code}): ${err.slice(0, 2000)}`),
        );
        return;
      }
      try {
        const parsed: unknown = JSON.parse(out.trim());
        if (
          !record(parsed) ||
          !record(parsed.result) ||
          !Array.isArray(parsed.result.context) ||
          typeof parsed.result.sessionFile !== "string" ||
          typeof parsed.result.sessionId !== "string"
        )
          throw new Error("Invalid worker response");
        resolve(parsed.result as unknown as WorkerResult);
      } catch (error) {
        reject(error);
      }
    });
    proc.stdin.end(JSON.stringify({ ...request, root }));
  });
}
