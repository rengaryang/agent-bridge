import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { record, sha256 } from "./util.js";
import { assertSession } from "./validation.js";
import { compileHandoff } from "./handoff.js";
import {
  createContextOnly,
  checkpointSession,
  renderCheckpoint,
  assertCheckpoint,
} from "./checkpoint.js";
import type {
  CanonicalSession,
  TransferProfile,
  SemanticCheckpoint,
} from "./types.js";
const MAX_TOTAL = 64 * 1024 * 1024,
  MAX_MEMBER = 32 * 1024 * 1024;
const allowed = new Set([
  "manifest.json",
  "session.json",
  "events.jsonl",
  "context.json",
  "handoff.md",
  "report/completeness.json",
  "checkpoint.json",
]);
const sensitive = new Set(
  [
    "apiKey",
    "api_key",
    "accessToken",
    "access_token",
    "refresh_token",
    "id_token",
    "authorization",
    "cookie",
    "thinkingSignature",
    "providerPayload",
    "preserveData",
    "encrypted_content",
    "credential_pin",
  ].map((key) => key.toLowerCase()),
);
function redact(v: unknown, depth = 0): unknown {
  if (depth > 64) throw new Error("Nesting exceeds 64 levels");
  if (typeof v === "string")
    return v
      .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
      .replace(
        /\b(?:ghp|github_pat|xoxb|xoxp)-?[A-Za-z0-9_]{12,}\b/g,
        "[REDACTED]",
      )
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{12,}/gi, "$1[REDACTED]");
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  if (record(v)) {
    if (["thinking", "reasoning", "redactedThinking"].includes(String(v.type)))
      return { type: "excluded-private-provider-state" };
    if (v.customType === "credential_pin")
      return { type: "custom", customType: "excluded-credential-pin" };
    return Object.fromEntries(
      Object.entries(v)
        .filter(
          ([key]) => !sensitive.has(key) && !sensitive.has(key.toLowerCase()),
        )
        .map(([key, value]) => [key, redact(value, depth + 1)]),
    );
  }
  return v;
}
export function portableSession(session: CanonicalSession): CanonicalSession {
  assertSession(session);
  if (session.security.profile === "context-only") {
    const cp = redact(session.checkpoint) as SemanticCheckpoint;
    assertCheckpoint(cp);
    return checkpointSession(
      cp,
      session.source.agent,
      session.cwd,
      sha256(JSON.stringify(cp)),
    );
  }
  const safe = redact(session) as CanonicalSession;
  safe.security = {
    profile: "portable-redacted",
    policy:
      "Preview v1: known credential keys/token patterns and provider replay carriers excluded; not a guarantee of secret-free content. Review before sharing.",
  };
  safe.issues.push({
    severity: "warning",
    code: "REDACTION_REVIEW_REQUIRED",
    message:
      "Pattern redaction is best effort; review all portable content before sharing.",
  });
  assertSession(safe);
  return safe;
}
export function encodeBundle(
  session: CanonicalSession,
  options: { profile?: TransferProfile; checkpoint?: unknown } = {},
): Uint8Array {
  if (
    options.profile !== undefined &&
    !["archive", "context-only"].includes(options.profile)
  )
    throw new Error("Unknown transfer profile");
  if (options.checkpoint !== undefined && options.profile !== "context-only")
    throw new Error("Explicit checkpoint requires context-only profile");
  if (
    options.profile === "archive" &&
    session.security.profile === "context-only"
  )
    throw new Error("Removed history cannot be restored as archive");
  const safe = portableSession(
    options.profile === "context-only"
      ? createContextOnly(session, options.checkpoint)
      : session,
  );
  const minimal = safe.security.profile === "context-only";
  const files: Record<string, Uint8Array> = {
    "session.json": strToU8(JSON.stringify(safe)),
    ...(minimal
      ? { "checkpoint.json": strToU8(JSON.stringify(safe.checkpoint)) }
      : {
          "events.jsonl": strToU8(
            safe.events.map((e) => JSON.stringify(e)).join("\n"),
          ),
        }),
    "context.json": strToU8(JSON.stringify(safe.context)),
    "handoff.md": strToU8(
      minimal
        ? renderCheckpoint(safe.checkpoint!)
        : compileHandoff(safe, 12000).text,
    ),
    "report/completeness.json": strToU8(JSON.stringify(safe.issues)),
  };
  const members = Object.entries(files).map(([path, data]) => ({
    path,
    size: data.length,
    sha256: sha256(data),
  }));
  files["manifest.json"] = strToU8(
    JSON.stringify({
      schemaVersion: 1,
      profile: safe.security.profile,
      members,
    }),
  );
  if (Object.values(files).reduce((n, x) => n + x.length, 0) > MAX_TOTAL)
    throw new Error("Bundle exceeds size limit");
  return zipSync(files, { level: 6, mtime: new Date("1980-01-01T00:00:00Z") });
}
/** Validate central directory BEFORE inflation; never extract paths to disk. */
function preflight(bytes: Uint8Array): void {
  if (bytes.length > MAX_TOTAL || bytes.length < 22)
    throw new Error("Invalid bundle size");
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--)
    if (
      b.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + b.readUInt16LE(i + 20) === b.length
    ) {
      end = i;
      break;
    }
  if (end < 0) throw new Error("Invalid ZIP directory");
  const count = b.readUInt16LE(end + 10),
    size = b.readUInt32LE(end + 12),
    offset = b.readUInt32LE(end + 16);
  if (
    b.readUInt16LE(end + 4) !== 0 ||
    b.readUInt16LE(end + 6) !== 0 ||
    b.readUInt16LE(end + 8) !== count ||
    count > 16 ||
    count === 0 ||
    offset + size !== end
  )
    throw new Error("Unsupported ZIP layout");
  const names = new Set<string>();
  let cursor = offset,
    total = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || b.readUInt32LE(cursor) !== 0x02014b50)
      throw new Error("Invalid ZIP member");
    const flags = b.readUInt16LE(cursor + 8),
      method = b.readUInt16LE(cursor + 10),
      compressed = b.readUInt32LE(cursor + 20),
      expanded = b.readUInt32LE(cursor + 24);
    const nameLen = b.readUInt16LE(cursor + 28),
      extraLen = b.readUInt16LE(cursor + 30),
      commentLen = b.readUInt16LE(cursor + 32);
    const local = b.readUInt32LE(cursor + 42),
      attrs = b.readUInt32LE(cursor + 38);
    if (
      cursor + 46 + nameLen + extraLen + commentLen > end ||
      local + 30 > offset
    )
      throw new Error("Truncated ZIP member");
    const name = b
      .subarray(cursor + 46, cursor + 46 + nameLen)
      .toString("utf8");
    if (
      !allowed.has(name) ||
      names.has(name) ||
      (flags & 1) !== 0 ||
      ![0, 8].includes(method) ||
      ((attrs >>> 16) & 0xf000) === 0xa000
    )
      throw new Error("Unsafe/duplicate ZIP member");
    if (
      b.readUInt32LE(local) !== 0x04034b50 ||
      b.readUInt16LE(local + 6) !== flags ||
      b.readUInt16LE(local + 8) !== method ||
      (flags & 8) !== 0 ||
      b.readUInt32LE(local + 18) !== compressed ||
      b.readUInt32LE(local + 22) !== expanded ||
      b.readUInt32LE(local + 14) !== b.readUInt32LE(cursor + 16)
    )
      throw new Error("Inconsistent local ZIP header");
    const ln = b.readUInt16LE(local + 26),
      le = b.readUInt16LE(local + 28);
    if (
      local + 30 + ln + le + compressed > offset ||
      b.subarray(local + 30, local + 30 + ln).toString("utf8") !== name
    )
      throw new Error("Inconsistent ZIP member");
    total += expanded;
    if (
      expanded > MAX_MEMBER ||
      total > MAX_TOTAL ||
      expanded / Math.max(compressed, 1) > 1000
    )
      throw new Error("ZIP expansion limit exceeded");
    names.add(name);
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  if (cursor !== end || !names.has("manifest.json"))
    throw new Error("Missing manifest or corrupt ZIP directory");
}
export function decodeBundle(bytes: Uint8Array): CanonicalSession {
  preflight(bytes);
  const files = unzipSync(bytes);
  const m: unknown = JSON.parse(strFromU8(files["manifest.json"]!));
  if (
    !record(m) ||
    m.schemaVersion !== 1 ||
    !["portable-redacted", "context-only"].includes(String(m.profile)) ||
    !Array.isArray(m.members)
  )
    throw new Error("Invalid bundle manifest");
  if (
    m.profile === "context-only" &&
    (Object.keys(m).length !== 3 ||
      Object.keys(m).some(
        (k) => !["schemaVersion", "profile", "members"].includes(k),
      ))
  )
    throw new Error("Context-only manifest contains unexpected metadata");
  const declared = new Set(["manifest.json"]);
  for (const member of m.members) {
    if (
      !record(member) ||
      typeof member.path !== "string" ||
      !allowed.has(member.path) ||
      declared.has(member.path) ||
      typeof member.size !== "number" ||
      typeof member.sha256 !== "string"
    )
      throw new Error("Invalid manifest member");
    if (
      m.profile === "context-only" &&
      (Object.keys(member).length !== 3 ||
        Object.keys(member).some(
          (k) => !["path", "size", "sha256"].includes(k),
        ))
    )
      throw new Error("Context-only member contains unexpected metadata");
    const data = files[member.path];
    if (!data || data.length !== member.size || sha256(data) !== member.sha256)
      throw new Error("Bundle member integrity mismatch");
    declared.add(member.path);
  }
  const required = new Set([
    "manifest.json",
    "session.json",
    "context.json",
    "handoff.md",
    "report/completeness.json",
    m.profile === "context-only" ? "checkpoint.json" : "events.jsonl",
  ]);
  if (
    Object.keys(files).length !== required.size ||
    Object.keys(files).some(
      (name) => !declared.has(name) || !required.has(name),
    ) ||
    [...required].some((name) => !files[name])
  )
    throw new Error("Mixed profile, undeclared or missing bundle member");
  const session: unknown = JSON.parse(strFromU8(files["session.json"]!));
  assertSession(session);
  if (
    JSON.stringify(session.context) !== strFromU8(files["context.json"]!) ||
    (m.profile === "context-only"
      ? JSON.stringify(session.checkpoint) !==
        strFromU8(files["checkpoint.json"]!)
      : session.events.map((e) => JSON.stringify(e)).join("\n") !==
        strFromU8(files["events.jsonl"]!)) ||
    JSON.stringify(session.issues) !==
      strFromU8(files["report/completeness.json"]!)
  )
    throw new Error("Bundle views disagree");
  if (session.security.profile !== m.profile)
    throw new Error("Unsupported bundle security profile");
  if (
    m.profile === "context-only" &&
    strFromU8(files["handoff.md"]!) !== renderCheckpoint(session.checkpoint!)
  )
    throw new Error("Context-only handoff disagrees with checkpoint");
  return session;
}
