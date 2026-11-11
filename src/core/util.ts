import { createHash, randomUUID } from "node:crypto";
import { open, link, unlink, stat } from "node:fs/promises";
import path from "node:path";
import type { RecordValue, AgentName } from "./types.js";
export function record(v: unknown): v is RecordValue {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
export function string(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
export function sha256(v: string | Uint8Array): string {
  return createHash("sha256").update(v).digest("hex");
}
export function agent(v: string): AgentName {
  if (!["pi", "omp", "codex"].includes(v))
    throw new Error("Agent must be pi, omp, or codex");
  return v as AgentName;
}
export function positiveInt(v: string | number): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0 || n > 1_000_000)
    throw new Error("Budget must be an integer between 1 and 1000000");
  return n;
}
export function parseRecords(text: string): RecordValue[] {
  if (Buffer.byteLength(text) > 32 * 1024 * 1024)
    throw new Error("Session exceeds preview 32 MiB limit");
  const result: RecordValue[] = [];
  for (const [i, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > 4 * 1024 * 1024)
      throw new Error(`Record ${i + 1} exceeds 4 MiB limit`);
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`Invalid JSONL at line ${i + 1}`);
    }
    if (!record(value) || typeof value.type !== "string")
      throw new Error(`Invalid record at line ${i + 1}`);
    result.push(value);
    if (result.length > 100000) throw new Error("Too many session records");
  }
  if (!result.length) throw new Error("Session is empty");
  return result;
}
export async function ensureDirectory(dir: string): Promise<string> {
  const absolute = path.resolve(dir);
  if (!(await stat(absolute)).isDirectory())
    throw new Error("Working directory is not a directory");
  return absolute;
}
/** Atomic, exclusive publication; never replaces an existing destination. */
export async function publish(
  file: string,
  content: string | Uint8Array,
): Promise<void> {
  const target = path.resolve(file);
  const tmp = path.join(path.dirname(target), `.abridge-${randomUUID()}.tmp`);
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(tmp, target);
  } finally {
    await unlink(tmp);
  }
}
