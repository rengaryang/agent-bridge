import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { nativeRuntimeCapabilities } from "../native/capabilities.js";
import type { AgentName } from "./types.js";
const run = promisify(execFile);
export async function probeAgents() {
  const runtimes = await nativeRuntimeCapabilities();
  return Promise.all(
    (["pi", "omp", "codex"] as AgentName[]).map(async (name) => {
      try {
        const r = await run(name, ["--version"], {
          timeout: 5000,
          maxBuffer: 65536,
        });
        return {
          name,
          installed: true,
          version: r.stdout.trim(),
          offlineDecoder: "preview",
          nativeHistoryImport: "unknown",
          nativeResumeVerified: false,
          nativeRuntime: runtimes.find((x) => x.target === name) ?? {
            nativeStorageImport: "unsupported",
            reason: "Codex history is cloud-only experimental",
          },
        };
      } catch {
        return {
          name,
          installed: false,
          version: null,
          offlineDecoder: "preview",
          nativeHistoryImport: "unknown",
          nativeResumeVerified: false,
          nativeRuntime: runtimes.find((x) => x.target === name) ?? {
            nativeStorageImport: "unsupported",
            reason: "Codex history is cloud-only experimental",
          },
        };
      }
    }),
  );
}
