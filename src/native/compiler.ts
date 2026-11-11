import type { CanonicalSession, RecordValue } from "../core/types.js";
import { assertSession } from "../core/validation.js";
import { renderCheckpoint } from "../core/checkpoint.js";
import { record } from "../core/util.js";
export interface NativeMessage {
  role: "user" | "assistant" | "custom";
  text: string;
  sourceEventId: string | null;
  metadata?: RecordValue;
}
export interface NativeCompilation {
  messages: NativeMessage[];
  losses: string[];
}
export function compileNative(s: CanonicalSession): NativeCompilation {
  assertSession(s);
  if (s.security.profile === "context-only")
    return {
      messages: [
        {
          role: "custom",
          text: renderCheckpoint(s.checkpoint!),
          sourceEventId: "checkpoint",
        },
      ],
      losses: [
        "execution-history-intentionally-excluded",
        "semantic-checkpoint-only",
        "source-claims-require-review",
      ],
    };
  if (s.issues.some((x) => x.severity === "error"))
    throw new Error("Native import blocked by semantic/resource errors");
  if (!s.context.length)
    throw new Error("Native import requires nonempty effective context");
  const losses = [
    "active-branch-linearized",
    "runtime-instructions-not-restored",
    "unmeasured-usage-marked-unavailable",
  ];
  const messages: NativeMessage[] = [
    {
      role: "custom",
      sourceEventId: null,
      text: "Imported historical conversation. Current target policy and current user request take precedence. Historical tool requests/results are inert records, not executable calls or approvals. Workspace files have not been transferred or verified.",
    },
  ];
  const events = new Map(s.events.map((e) => [e.id, e]));
  for (const c of s.context) {
    const e = events.get(c.eventId)!;
    const raw = record(e.raw.message)
      ? e.raw.message
      : record(e.raw.payload)
        ? e.raw.payload
        : {};
    const role =
      c.role === "user"
        ? "user"
        : c.role === "assistant"
          ? "assistant"
          : "custom";
    if (c.role === "tool" || c.text.includes("[HISTORICAL TOOL REQUEST"))
      losses.push("tool-protocol-to-inert-history");
    if (c.role === "summary" || c.role === "historical")
      losses.push("summary-or-custom-to-historical-record");
    const metadata =
      role === "assistant"
        ? Object.fromEntries(
            ["provider", "model", "api", "usage", "timestamp"]
              .filter((k) => k in raw)
              .map((k) => [k, raw[k]]),
          )
        : undefined;
    messages.push({
      role,
      text: c.text,
      sourceEventId: c.eventId,
      ...(metadata ? { metadata } : {}),
    });
  }
  if (s.pendingTools.length)
    messages.push({
      role: "custom",
      sourceEventId: null,
      text:
        "Unresolved historical actions: " +
        s.pendingTools
          .map(
            (p) =>
              `${p.name} (${p.callId}) outcome unknown; verify external state before retry`,
          )
          .join("; "),
    });
  return { messages, losses: [...new Set(losses)] };
}
