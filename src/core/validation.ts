import { Ajv } from "ajv";
import { assertContextOnly } from "./checkpoint.js";
import type { CanonicalSession } from "./types.js";
const schema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "source",
    "title",
    "cwd",
    "selectedLeaf",
    "leafEvidence",
    "events",
    "context",
    "pendingTools",
    "issues",
    "security",
  ],
  properties: {
    schemaVersion: { const: 1 },
    source: {
      type: "object",
      additionalProperties: false,
      required: ["agent", "sessionId", "formatVersion", "digest"],
      properties: {
        agent: { enum: ["pi", "omp", "codex"] },
        sessionId: { type: "string", minLength: 1 },
        formatVersion: { type: ["number", "null"] },
        digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
        path: { type: "string" },
      },
    },
    title: { type: ["string", "null"] },
    cwd: { type: "string", minLength: 1 },
    selectedLeaf: { type: ["string", "null"] },
    leafEvidence: { enum: ["explicit", "lastPersistedRecord"] },
    events: {
      type: "array",
      maxItems: 100000,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "parentId", "ordinal", "kind", "raw"],
        properties: {
          id: { type: "string", minLength: 1 },
          parentId: { type: ["string", "null"] },
          ordinal: { type: "integer", minimum: 0 },
          kind: { type: "string" },
          raw: { type: "object" },
        },
      },
    },
    context: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["eventId", "role", "text", "sourceOrdinal"],
        properties: {
          eventId: { type: "string" },
          role: {
            enum: ["user", "assistant", "tool", "summary", "historical"],
          },
          text: { type: "string" },
          sourceOrdinal: { type: "integer", minimum: 0 },
        },
      },
    },
    pendingTools: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["callId", "eventId", "name", "status"],
        properties: {
          callId: { type: "string" },
          eventId: { type: "string" },
          name: { type: "string" },
          status: { const: "outcomeUnknown" },
        },
      },
    },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "code", "message"],
        properties: {
          severity: { enum: ["warning", "error"] },
          code: { type: "string" },
          message: { type: "string" },
          eventId: { type: "string" },
        },
      },
    },
    checkpoint: { type: "object" },
    security: {
      type: "object",
      additionalProperties: false,
      required: ["profile", "policy"],
      properties: {
        profile: {
          enum: ["unredacted-local", "portable-redacted", "context-only"],
        },
        policy: { type: "string" },
      },
    },
  },
};
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
export function assertSession(v: unknown): asserts v is CanonicalSession {
  if (!validate(v))
    throw new Error(
      `Invalid canonical session: ${validate.errors?.map((e) => e.instancePath + " " + e.message).join("; ")}`,
    );
  const s = v as unknown as CanonicalSession;
  const ids = new Set<string>();
  for (const e of s.events) {
    if (ids.has(e.id)) throw new Error("Duplicate event ID");
    ids.add(e.id);
  }
  for (const e of s.events)
    if (e.parentId !== null && !ids.has(e.parentId))
      throw new Error("Missing event parent");
  if (s.selectedLeaf !== null && !ids.has(s.selectedLeaf))
    throw new Error("Invalid selected leaf");
  const byId = new Map(s.events.map((e) => [e.id, e]));
  const checked = new Set<string>();
  for (const e of s.events) {
    const seen = new Set<string>();
    let current: string | null = e.id;
    while (current !== null && !checked.has(current)) {
      if (seen.has(current)) throw new Error("Cyclic event graph");
      seen.add(current);
      current = byId.get(current)!.parentId;
    }
    for (const id of seen) checked.add(id);
  }
  for (const c of s.context)
    if (!ids.has(c.eventId) || byId.get(c.eventId)!.ordinal !== c.sourceOrdinal)
      throw new Error("Invalid context provenance");
  if (s.security.profile === "context-only") assertContextOnly(s);
  else if (s.checkpoint !== undefined)
    throw new Error("Checkpoint is only allowed in context-only profile");
  for (const p of s.pendingTools)
    if (!ids.has(p.eventId)) throw new Error("Invalid pending tool provenance");
}
