import { open, stat } from "node:fs/promises";
import path from "node:path";
import { decodeText } from "../adapters/index.js";
import type { AgentName, CanonicalSession } from "./types.js";
export async function readSnapshot(
  agent: AgentName,
  file: string,
  leaf?: string,
): Promise<CanonicalSession> {
  const absolute = path.resolve(file);
  const handle = await open(absolute, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 32 * 1024 * 1024)
      throw new Error("Source exceeds 32 MiB preview limit");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (result.bytesRead === 0)
        throw new Error("Source truncated during snapshot");
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    const current = await stat(absolute);
    if (
      before.ino !== current.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error(
        "Source changed during snapshot; wait until idle and retry",
      );
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const session = decodeText(agent, text, {
      path: absolute,
      ...(leaf ? { leaf } : {}),
    });
    session.issues.push({
      severity: "warning",
      code: "OFFLINE_SNAPSHOT",
      message:
        "Offline persisted snapshot only; live leaf, queued messages and runtime jobs are not captured.",
    });
    return session;
  } finally {
    await handle.close();
  }
}
