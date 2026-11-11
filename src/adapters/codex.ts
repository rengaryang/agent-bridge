import type {
  CanonicalEvent,
  CanonicalSession,
  DecodeOptions,
  RecordValue,
} from "../core/types.js";
import { parseRecords, record, string, sha256 } from "../core/util.js";
import {
  analyzeResources,
  contentText,
  emptySession,
  contextMessage,
  messageRecord,
  pendingTools,
} from "../core/context.js";
import { assertSession } from "../core/validation.js";
export function decodeCodex(
  text: string,
  options: DecodeOptions = {},
): CanonicalSession {
  if (options.leaf)
    throw new Error(
      "Codex preview decoder does not support tree leaf selection",
    );
  const records = parseRecords(text);
  const header = records.shift();
  if (
    header?.type !== "session_meta" ||
    !record(header.payload) ||
    !string(header.payload.id) ||
    !string(header.payload.cwd)
  )
    throw new Error("Invalid Codex session metadata");
  const s = emptySession(
    "codex",
    header.payload.id as string,
    header.payload.cwd as string,
    sha256(text),
  );
  if (options.path) s.source.path = options.path;
  const canonicalIds = new Set<string>();
  for (const r of records)
    if (r.type === "response_item" && record(r.payload)) {
      const id = string(r.payload.id);
      if (id) canonicalIds.add(id);
      const call = string(r.payload.call_id);
      if (call) canonicalIds.add(call);
    }
  const active: CanonicalEvent[] = [];
  const callNames = new Map<string, string>();
  let previous: string | null = null;
  for (const [ordinal, r] of records.entries()) {
    const id = `codex-${ordinal}`;
    const original: CanonicalEvent = {
      id,
      parentId: previous,
      ordinal,
      kind: String(r.type),
      raw: r,
    };
    s.events.push(original);
    previous = id;
    if (!record(r.payload)) {
      s.issues.push({
        severity: "error",
        code: "UNKNOWN_CONTEXT_EFFECT",
        message: "Codex record payload is unsupported.",
        eventId: id,
      });
      continue;
    }
    const p = r.payload;
    let converted: RecordValue | undefined;
    let kind = "message";
    if (r.type === "response_item") {
      const type = string(p.type);
      if (type === "message") {
        if (
          !["user", "assistant", "system", "developer"].includes(String(p.role))
        )
          s.issues.push({
            severity: "error",
            code: "UNKNOWN_CONTEXT_EFFECT",
            message: "Unsupported Codex message role.",
            eventId: id,
          });
        converted = messageRecord(String(p.role), p.content);
      } else if (type === "function_call" || type === "custom_tool_call") {
        const call = string(p.call_id) ?? string(p.id);
        if (!call) throw new Error("Codex tool call lacks ID");
        const name = string(p.name) ?? "unknown";
        callNames.set(call, name);
        converted = messageRecord("assistant", [
          {
            type: "toolCall",
            id: call,
            name,
            arguments: p.arguments ?? p.input,
          },
        ]);
      } else if (
        type === "function_call_output" ||
        type === "custom_tool_call_output"
      ) {
        const call = string(p.call_id);
        if (!call) throw new Error("Codex tool result lacks ID");
        converted = messageRecord(
          "toolResult",
          typeof p.output === "string" ? p.output : contentText(p.output),
          {
            toolCallId: call,
            toolName: callNames.get(call) ?? "unknown",
            isError: p.isError ?? "unknown",
          },
        );
      } else if (type === "reasoning")
        s.issues.push({
          severity: "warning",
          code: "REASONING_EXCLUDED",
          message: "Provider reasoning is not injected across agents.",
          eventId: id,
        });
      else
        s.issues.push({
          severity: "error",
          code: "UNKNOWN_CONTEXT_EFFECT",
          message: "Unsupported Codex response item requires native reducer.",
          eventId: id,
        });
    } else if (r.type === "event_msg") {
      const type = string(p.type);
      const mirrorId =
        string(p.item_id) ?? string(p.itemId) ?? string(p.call_id);
      if (mirrorId && canonicalIds.has(mirrorId)) continue;
      if (type === "user_message" || type === "agent_message") {
        const role = type === "user_message" ? "user" : "assistant";
        // A mirror without identity may be paired only once, next to matching authoritative response data.
        const textValue = string(p.message) ?? "";
        const last = active.at(-1);
        const previousRecord = ordinal > 0 ? records[ordinal - 1] : undefined;
        if (
          !mirrorId &&
          previousRecord?.type === "response_item" &&
          last &&
          record(last.raw.message) &&
          last.raw.message.role === role &&
          contentText(last.raw.message.content) === textValue
        )
          continue;
        converted = messageRecord(role, textValue);
      } else if (type === "thread_rolled_back") {
        const turns = p.num_turns;
        if (
          typeof turns !== "number" ||
          !Number.isSafeInteger(turns) ||
          turns < 0
        )
          throw new Error("Invalid Codex rollback");
        for (let n = 0; n < turns; n++) {
          const index = active.findLastIndex(
            (e) =>
              e.kind === "message" &&
              record(e.raw.message) &&
              e.raw.message.role === "user",
          );
          if (index < 0) break;
          active.splice(index);
        }
      } else if (type === "thread_name_updated")
        s.title = string(p.thread_name) ?? s.title;
      else if (
        [
          "task_started",
          "task_complete",
          "turn_started",
          "turn_complete",
          "token_count",
          "agent_reasoning",
          "agent_reasoning_section_break",
          "context_compaction",
        ].includes(String(type))
      ) {
        if (type === "agent_reasoning")
          s.issues.push({
            severity: "warning",
            code: "REASONING_EXCLUDED",
            message: "Reasoning excluded from handoff.",
            eventId: id,
          });
      } else
        s.issues.push({
          severity: "error",
          code: "UNKNOWN_CONTEXT_EFFECT",
          message:
            "Unsupported Codex event; preview cannot prove its context effect.",
          eventId: id,
        });
    } else if (r.type === "compacted") {
      let summary = string(p.message)?.trim();
      if (!summary && Array.isArray(p.replacement_history))
        summary = p.replacement_history
          .filter(record)
          .map((x) =>
            x.type === "message"
              ? contentText(x.content)
              : (string(x.summary) ?? ""),
          )
          .filter(Boolean)
          .join("\n");
      if (
        !summary ||
        (Array.isArray(p.replacement_history) &&
          p.replacement_history.some(
            (x) =>
              record(x) &&
              x.type === "compaction" &&
              x.encrypted_content != null,
          ))
      )
        s.issues.push({
          severity: "error",
          code: "OPAQUE_COMPACTION",
          message: "Cannot reconstruct opaque-only Codex compacted context.",
          eventId: id,
        });
      converted = { summary: summary ?? "" };
      kind = "compaction";
      active.length = 0;
    } else if (r.type === "turn_context") {
      // version/model/sandbox metadata is archived, never activated
    } else
      s.issues.push({
        severity: "error",
        code: "UNKNOWN_CONTEXT_EFFECT",
        message: "Unsupported Codex rollout record.",
        eventId: id,
      });
    if (converted) active.push({ ...original, kind, raw: converted });
  }
  s.selectedLeaf = previous;
  for (const e of active) {
    const m = contextMessage(e);
    if (m?.text) s.context.push(m);
    analyzeResources(e.raw, e.id, s.issues);
    if (
      record(e.raw.message) &&
      ["system", "developer"].includes(String(e.raw.message.role))
    )
      s.issues.push({
        severity: "warning",
        code: "NATIVE_INSTRUCTIONS_EXCLUDED",
        message: "Runtime instructions excluded.",
        eventId: e.id,
      });
  }
  s.pendingTools = pendingTools(active);
  if (s.pendingTools.length)
    s.issues.push({
      severity: "warning",
      code: "UNRESOLVED_TOOLS",
      message: "Historical tool outcomes unknown.",
    });
  assertSession(s);
  return s;
}
