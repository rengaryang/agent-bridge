import type {
  CanonicalEvent,
  CanonicalSession,
  DecodeOptions,
  RecordValue,
} from "../core/types.js";
import { parseRecords, record, string, sha256 } from "../core/util.js";
import { assertSession } from "../core/validation.js";
import {
  analyzeResources,
  contextMessage,
  emptySession,
  pendingTools,
} from "../core/context.js";
const stateOnly = new Set([
  "model_change",
  "thinking_level_change",
  "usage",
  "model_usage",
  "service_tier_change",
  "label",
  "session_info",
  "title_change",
  "ttsr_injection",
  "credential_pin",
  "session_init",
  "mode_change",
]);
const contributing = new Set([
  "message",
  "custom_message",
  "branch_summary",
  "compaction",
  "context_edit",
  "reset_boundary",
]);
export function decodeTree(
  agent: "pi" | "omp",
  text: string,
  options: DecodeOptions = {},
): CanonicalSession {
  const records = parseRecords(text);
  let title: string | null = null;
  if (agent === "omp" && records[0]?.type === "title")
    title = string(records.shift()!.title) ?? null;
  const header = records.shift();
  if (
    !header ||
    header.type !== "session" ||
    !string(header.id) ||
    !string(header.cwd)
  )
    throw new Error("Invalid native session header");
  if (
    header.version !== undefined &&
    ![1, 2, 3].includes(Number(header.version))
  )
    throw new Error("Unsupported native session version");
  const s = emptySession(
    agent,
    header.id as string,
    header.cwd as string,
    sha256(text),
  );
  s.title = title ?? string(header.title) ?? null;
  s.source.formatVersion =
    typeof header.version === "number" ? header.version : 1;
  if (options.path) s.source.path = options.path;
  let previous: string | null = null;
  for (const [ordinal, raw] of records.entries()) {
    const id =
      string(raw.id) ??
      (s.source.formatVersion === 1 ? `legacy-${ordinal}` : undefined);
    if (!id) throw new Error("Missing tree event id");
    const parent =
      raw.parentId === null
        ? null
        : (string(raw.parentId) ??
          (s.source.formatVersion === 1 ? previous : undefined));
    if (parent === undefined) throw new Error("Missing tree event parentId");
    const e: CanonicalEvent = {
      id,
      parentId: parent,
      ordinal,
      kind: String(raw.type),
      raw,
    };
    s.events.push(e);
    previous = id;
    if (raw.type === "session_info") s.title = string(raw.name) ?? s.title;
    if (raw.type === "title_change") s.title = string(raw.title) ?? s.title;
    if (
      !stateOnly.has(e.kind) &&
      !contributing.has(e.kind) &&
      e.kind !== "custom"
    )
      s.issues.push({
        severity: "error",
        code: "UNKNOWN_CONTEXT_EFFECT",
        message: "Unknown native event requires a version-specific reducer.",
        eventId: id,
      });
    if (e.kind === "custom")
      s.issues.push({
        severity: "warning",
        code: "CUSTOM_STATE_INERT",
        message: "Extension/runtime state archived but not restored.",
        eventId: id,
      });
    if (e.kind === "session_init" || e.kind === "mode_change")
      s.issues.push({
        severity: "warning",
        code: "RUNTIME_STATE_INERT",
        message: "Native runtime state is not activated in target.",
        eventId: id,
      });
    if (e.kind === "message" && !record(raw.message))
      throw new Error("Invalid native message");
    if (e.kind === "message" && record(raw.message)) {
      const role = string(raw.message.role);
      if (!role) throw new Error("Invalid native message role");
      if (
        ![
          "system",
          "developer",
          "user",
          "assistant",
          "toolResult",
          "custom",
          "hookMessage",
          "bashExecution",
          "pythonExecution",
          "fileMention",
        ].includes(role)
      )
        s.issues.push({
          severity: "error",
          code: "UNKNOWN_CONTEXT_EFFECT",
          message: "Unknown native message role.",
          eventId: id,
        });
      if (role === "system" || role === "developer")
        s.issues.push({
          severity: "warning",
          code: "NATIVE_INSTRUCTIONS_EXCLUDED",
          message:
            "Source runtime instructions are not promoted to target instructions.",
          eventId: id,
        });
    }
  }
  s.selectedLeaf = options.leaf ?? previous;
  s.leafEvidence = options.leaf ? "explicit" : "lastPersistedRecord";
  assertSession(s);
  const byId = new Map(s.events.map((e) => [e.id, e]));
  const branch: CanonicalEvent[] = [];
  let next = s.selectedLeaf;
  while (next !== null) {
    const e = byId.get(next)!;
    branch.push(e);
    next = e.parentId;
  }
  branch.reverse();
  let active = branch;
  const reset = branch.findLastIndex((e) => e.kind === "reset_boundary");
  if (reset >= 0) active = branch.slice(reset + 1);
  const c = active.findLastIndex((e) => e.kind === "compaction");
  if (c >= 0) {
    const comp = active[c]!;
    const first = string(comp.raw.firstKeptEntryId);
    if (!first) throw new Error("Compaction lacks retained boundary");
    const retained =
      first === comp.id ? c : active.findIndex((e) => e.id === first);
    if (retained < 0 || retained > c)
      throw new Error("Invalid compaction retained boundary");
    if (!string(comp.raw.summary)?.trim() || comp.raw.preserveData != null)
      s.issues.push({
        severity: "error",
        code: "OPAQUE_COMPACTION",
        message:
          "Native compaction requires readable validated replacement context.",
        eventId: comp.id,
      });
    active = [
      comp,
      ...active
        .slice(retained, c)
        .filter(
          (e) =>
            !(
              e.kind === "message" &&
              record(e.raw.message) &&
              e.raw.message.role === "system"
            ),
        ),
      ...active.slice(c + 1),
    ];
  }
  const edits = new Map<string, RecordValue>();
  for (const e of active)
    if (e.kind === "context_edit") {
      const target = string(e.raw.targetId);
      if (!target || !byId.has(target))
        throw new Error("Context edit targets missing event");
      if (!branch.some((x) => x.id === target))
        throw new Error("Context edit target is outside active branch");
      edits.set(target, e.raw);
    }
  for (const e of active) {
    if (e.kind === "compaction" && e !== active[0]) continue;
    let projected = e;
    const edit = edits.get(e.id);
    if (edit) {
      if (edit.replacement === null) continue;
      if (!record(edit.replacement) || !("content" in edit.replacement))
        throw new Error("Invalid context edit replacement");
      const r = { ...e.raw };
      if (record(r.message))
        r.message = { ...r.message, content: edit.replacement.content };
      else r.content = edit.replacement.content;
      projected = { ...e, raw: r };
    }
    const message = contextMessage(projected);
    if (message?.text) s.context.push(message);
    analyzeResources(projected.raw, e.id, s.issues);
  }
  s.pendingTools = pendingTools(active);
  if (s.pendingTools.length)
    s.issues.push({
      severity: "warning",
      code: "UNRESOLVED_TOOLS",
      message:
        "Tool outcome is unknown; verify external state before any retry.",
    });
  assertSession(s);
  return s;
}
