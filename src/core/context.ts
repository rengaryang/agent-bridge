import type {
  CanonicalEvent,
  CanonicalSession,
  ContextMessage,
  Issue,
  PendingTool,
  RecordValue,
} from "./types.js";
import { record, string } from "./util.js";
export function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (!record(part)) return "";
      if (["text", "input_text", "output_text"].includes(String(part.type)))
        return string(part.text) ?? "";
      if (
        ["toolCall", "function_call", "custom_tool_call"].includes(
          String(part.type),
        )
      )
        return `[HISTORICAL TOOL REQUEST ${string(part.name) ?? "unknown"}; not executed by migration] ${JSON.stringify(part.arguments ?? part.input ?? {})}`;
      if (
        ["image", "input_image", "file", "image_url"].includes(
          String(part.type),
        )
      )
        return "[RESOURCE NOT INCLUDED IN PREVIEW]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
export function contextMessage(e: CanonicalEvent): ContextMessage | undefined {
  const r = e.raw;
  if (e.kind === "compaction" || e.kind === "branch_summary")
    return {
      eventId: e.id,
      role: "summary",
      text: string(r.summary) ?? "",
      sourceOrdinal: e.ordinal,
    };
  if (e.kind === "custom_message")
    return {
      eventId: e.id,
      role: "historical",
      text: contentText(r.content),
      sourceOrdinal: e.ordinal,
    };
  if (e.kind !== "message" || !record(r.message)) return undefined;
  const role = string(r.message.role);
  if (role === "system" || role === "developer") return undefined; // never promote native runtime instructions
  const mapped =
    role === "user"
      ? "user"
      : role === "assistant"
        ? "assistant"
        : role === "toolResult"
          ? "tool"
          : "historical";
  let text = contentText(r.message.content);
  if (role === "toolResult")
    text = `[HISTORICAL TOOL RESULT ${string(r.message.toolName) ?? "unknown"}; isError=${String(r.message.isError ?? "unknown")}] ${text}`;
  return { eventId: e.id, role: mapped, text, sourceOrdinal: e.ordinal };
}
export function analyzeResources(
  value: unknown,
  eventId: string,
  issues: Issue[],
  depth = 0,
): void {
  if (depth > 64) throw new Error("Record nesting exceeds 64 levels");
  if (Array.isArray(value)) {
    for (const v of value) analyzeResources(v, eventId, issues, depth + 1);
    return;
  }
  if (!record(value)) return;
  if (["system", "developer"].includes(String(value.role))) return;
  if (Array.isArray(value.content))
    for (const block of value.content) {
      if (
        !record(block) ||
        ![
          "text",
          "input_text",
          "output_text",
          "toolCall",
          "image",
          "input_image",
          "file",
          "image_url",
          "thinking",
          "reasoning",
          "redactedThinking",
        ].includes(String(block.type))
      )
        issues.push({
          severity: "error",
          code: "UNKNOWN_CONTEXT_EFFECT",
          message: "Unsupported content block cannot be silently omitted.",
          eventId,
        });
      if (
        record(block) &&
        ["thinking", "reasoning", "redactedThinking"].includes(
          String(block.type),
        )
      )
        issues.push({
          severity: "warning",
          code: "REASONING_EXCLUDED",
          message: "Reasoning omitted from portable history.",
          eventId,
        });
    }
  if (
    ["image", "input_image", "file", "image_url", "imageView"].includes(
      String(value.type),
    )
  )
    issues.push({
      severity: "error",
      code: "RESOURCE_NOT_PACKAGED",
      message:
        "Referenced media is not packaged by preview; supply an explicit textual handoff.",
      eventId,
    });
  for (const [key, v] of Object.entries(value)) {
    if (
      typeof v === "string" &&
      /^(blob:sha256:|artifact:\/\/|local:\/\/|agent:\/\/)/.test(v)
    )
      issues.push({
        severity: "error",
        code: "RESOURCE_NOT_PACKAGED",
        message: "Native resource reference requires an asset resolver.",
        eventId,
      });
    if (
      [
        "encrypted_content",
        "thinkingSignature",
        "providerPayload",
        "preserveData",
      ].includes(key) &&
      v != null
    )
      issues.push({
        severity: "warning",
        code: "PROVIDER_STATE_EXCLUDED",
        message:
          "Provider replay state is archive-only and excluded from portable export.",
        eventId,
      });
    analyzeResources(v, eventId, issues, depth + 1);
  }
}
export function pendingTools(events: CanonicalEvent[]): PendingTool[] {
  const outstanding = new Map<string, PendingTool>();
  for (const e of events) {
    const message = e.raw.message;
    if (!record(message)) continue;
    if (message.role === "assistant" && Array.isArray(message.content))
      for (const block of message.content) {
        if (!record(block) || block.type !== "toolCall") continue;
        const id = string(block.id);
        if (id)
          outstanding.set(id, {
            callId: id,
            eventId: e.id,
            name: string(block.name) ?? "unknown",
            status: "outcomeUnknown",
          });
      }
    if (message.role === "toolResult") {
      const id = string(message.toolCallId);
      if (id) outstanding.delete(id);
    }
  }
  return [...outstanding.values()];
}
export function emptySession(
  agent: CanonicalSession["source"]["agent"],
  id: string,
  cwd: string,
  digest: string,
): CanonicalSession {
  return {
    schemaVersion: 1,
    source: { agent, sessionId: id, formatVersion: null, digest },
    title: null,
    cwd,
    selectedLeaf: null,
    leafEvidence: "lastPersistedRecord",
    events: [],
    context: [],
    pendingTools: [],
    issues: [],
    security: {
      profile: "unredacted-local",
      policy: "No credentials or runtime state copied to a target agent.",
    },
  };
}
export function messageRecord(
  role: string,
  content: unknown,
  fields: RecordValue = {},
): RecordValue {
  return { message: { role, content, ...fields } };
}
