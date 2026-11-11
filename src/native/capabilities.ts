import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
export async function nativeRuntimeCapabilities() {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  return Promise.all(
    (["pi", "omp"] as const).map(async (target) => {
      const pkg =
        target === "pi"
          ? "@earendil-works/pi-coding-agent"
          : "@oh-my-pi/pi-coding-agent";
      const expected = target === "pi" ? "1.5.1" : "18.16.0";
      try {
        const version = JSON.parse(
          await readFile(
            path.join(
              root,
              "runtimes",
              target,
              "node_modules",
              pkg,
              "package.json",
            ),
            "utf8",
          ),
        ).version;
        if (target === "omp")
          await access(
            path.join(
              root,
              "runtimes/omp/node_modules/@oven/bun-darwin-aarch64/bin/bun",
            ),
          );
        return {
          target,
          sdkVersion: version,
          ready:
            version === expected &&
            process.platform === "darwin" &&
            process.arch === "arm64",
          nativeStorageImport: "version-pinned-preview",
          storageContextColdRestoreTested: true,
          modelContinuationVerified: false,
        };
      } catch {
        return {
          target,
          sdkVersion: null,
          ready: false,
          nativeStorageImport: "requires-runtime-setup",
          storageContextColdRestoreTested: false,
          modelContinuationVerified: false,
        };
      }
    }),
  );
}
