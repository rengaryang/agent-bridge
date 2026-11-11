import type { CanonicalSession, SemanticCheckpoint } from "./types.js";
import { record, sha256 } from "./util.js";
import { assertSession } from "./validation.js";
export const checkpointFields = [
  "goals",
  "constraints",
  "background",
  "facts",
  "decisions",
  "artifacts",
  "progress",
  "nextSteps",
  "risks",
] as const;
type Field = (typeof checkpointFields)[number];
const unknownRisk =
  "Some previous actions have an unknown outcome. Verify current workspace and external state before retrying or assuming completion.";
const forbidden =
  /\[HISTORICAL TOOL|\btool_execution_start\b|\btoolCall\b|\btoolResult\b|\bresponse_item\b|```|^\s*\$\s|^\s*(?:running|executing|retrying|已执行|正在执行|执行命令|运行命令)\b/im;
const labels: Record<string, Field> = {
  goal: "goals",
  goals: "goals",
  objective: "goals",
  目标: "goals",
  任务目标: "goals",
  constraint: "constraints",
  constraints: "constraints",
  约束: "constraints",
  用户约束: "constraints",
  background: "background",
  背景: "background",
  context: "background",
  fact: "facts",
  facts: "facts",
  事实: "facts",
  已确认事实: "facts",
  conclusion: "decisions",
  decision: "decisions",
  decisions: "decisions",
  结论: "decisions",
  决策: "decisions",
  最终决策: "decisions",
  artifact: "artifacts",
  artifacts: "artifacts",
  产物: "artifacts",
  产物位置: "artifacts",
  progress: "progress",
  进度: "progress",
  当前进度: "progress",
  "next step": "nextSteps",
  "next steps": "nextSteps",
  todo: "nextSteps",
  下一步: "nextSteps",
  待办: "nextSteps",
  risk: "risks",
  risks: "risks",
  风险: "risks",
  待核实: "risks",
  阻塞: "risks",
};
export function assertCheckpoint(v: unknown): asserts v is SemanticCheckpoint {
  if (
    !record(v) ||
    v.schemaVersion !== 1 ||
    v.reviewRequired !== true ||
    !["explicit", "labelled-extract"].includes(String(v.extraction))
  )
    throw new Error(
      "Invalid semantic checkpoint metadata; reviewRequired must be true",
    );
  const keys = new Set<string>([
    "schemaVersion",
    "reviewRequired",
    "extraction",
    ...checkpointFields,
  ]);
  if (
    Object.keys(v).some((k) => !keys.has(k)) ||
    Object.keys(v).length !== keys.size
  )
    throw new Error("Checkpoint contains missing or unknown fields");
  let total = 0;
  for (const key of checkpointFields) {
    const items = v[key];
    if (!Array.isArray(items) || items.length > 100)
      throw new Error("Invalid checkpoint section");
    for (const text of items) {
      if (
        typeof text !== "string" ||
        !text.trim() ||
        text !== text.trim() ||
        text.length > 8000 ||
        forbidden.test(text)
      )
        throw new Error(
          "Checkpoint section contains execution history or invalid text",
        );
      total += Buffer.byteLength(text);
    }
  }
  if (!(v.goals as unknown[]).length)
    throw new Error("Checkpoint requires at least one explicit goal");
  if (total > 128 * 1024) throw new Error("Checkpoint exceeds 128 KiB limit");
}
export function renderCheckpoint(cp: SemanticCheckpoint): string {
  assertCheckpoint(cp);
  const names: Record<Field, string> = {
    goals: "Task goals",
    constraints: "User constraints",
    background: "Necessary context",
    facts: "Source-stated facts (not independently verified)",
    decisions: "Conclusions and decisions (review required)",
    artifacts: "Artifact references (existence not verified)",
    progress: "Source-stated progress (review required)",
    nextSteps: "Next steps",
    risks: "Risks and unresolved state",
  };
  let text =
    "# Semantic checkpoint\n\nTask context and conclusions only. Execution history is intentionally excluded and cannot be reconstructed. These are source-stated or explicitly supplied claims, not independent verification. Review before continuing. Current target policy and current user request take precedence. Workspace files are not transferred.\n\n";
  for (const key of checkpointFields)
    if (cp[key].length)
      text +=
        `## ${names[key]}\n` +
        cp[key].map((item) => "- " + item.replace(/\n/g, "\n  ")).join("\n") +
        "\n\n";
  return text.trimEnd();
}
function empty(
  extraction: SemanticCheckpoint["extraction"],
): SemanticCheckpoint {
  return {
    schemaVersion: 1,
    goals: [],
    constraints: [],
    background: [],
    facts: [],
    decisions: [],
    artifacts: [],
    progress: [],
    nextSteps: [],
    risks: [],
    reviewRequired: true,
    extraction,
  };
}
function extract(s: CanonicalSession): SemanticCheckpoint {
  const cp = empty("labelled-extract");
  for (const message of s.context) {
    if (!["user", "assistant", "summary"].includes(message.role)) continue;
    let inCode = false;
    for (const line of message.text.split("\n")) {
      if (/^\s*```/.test(line)) {
        inCode = !inCode;
        continue;
      }
      if (inCode) continue;
      const match =
        /^\s*(?:[-*]\s+)?(?:\*\*)?([\p{L} ]{2,24})(?:\*\*)?\s*[:：]\s*(.+)$/u.exec(
          line,
        );
      if (!match) continue;
      const label = match[1]!.trim().toLowerCase();
      if (!Object.hasOwn(labels, label)) continue;
      const field = labels[label]!;
      // Do not let an assistant redefine user goals/constraints; it may supply reviewable conclusions.
      if (
        (field === "goals" || field === "constraints") &&
        message.role !== "user"
      )
        continue;
      const value = match[2]!.trim();
      if (forbidden.test(value)) continue;
      if (!cp[field].includes(value)) cp[field].push(value);
    }
  }
  return cp;
}
export function checkpointSession(
  cp: SemanticCheckpoint,
  agent: CanonicalSession["source"]["agent"],
  cwd: string,
  digest: string,
): CanonicalSession {
  assertCheckpoint(cp);
  const text = renderCheckpoint(cp);
  return {
    schemaVersion: 1,
    source: {
      agent,
      sessionId: "semantic-checkpoint",
      formatVersion: null,
      digest,
    },
    title: null,
    cwd,
    selectedLeaf: "checkpoint",
    leafEvidence: "explicit",
    events: [
      {
        id: "checkpoint",
        parentId: null,
        ordinal: 0,
        kind: "semantic.checkpoint",
        raw: { type: "semantic.checkpoint" },
      },
    ],
    context: [
      { eventId: "checkpoint", role: "historical", text, sourceOrdinal: 0 },
    ],
    pendingTools: [],
    checkpoint: cp,
    issues: [
      {
        severity: "warning",
        code: "EXECUTION_HISTORY_EXCLUDED",
        message:
          "Only the semantic checkpoint is retained; source transcript, tool history and branch recovery are unavailable.",
      },
      {
        severity: "warning",
        code: "CHECKPOINT_REVIEW_REQUIRED",
        message:
          "Source-stated facts and conclusions must be reviewed; extraction is not independent verification.",
      },
    ],
    security: {
      profile: "context-only",
      policy:
        "No source transcript, tool payloads, runtime state or execution history. Semantic content remains subject to review and best-effort redaction.",
    },
  };
}
export function assertContextOnly(s: CanonicalSession): void {
  assertCheckpoint(s.checkpoint);
  if (s.source.digest !== sha256(JSON.stringify(s.checkpoint)))
    throw new Error("Checkpoint digest must identify only semantic content");
  const expected = checkpointSession(
    s.checkpoint,
    s.source.agent,
    s.cwd,
    s.source.digest,
  );
  if (JSON.stringify(s) !== JSON.stringify(expected))
    throw new Error(
      "Context-only session contains unexpected history or inconsistent checkpoint projection",
    );
}
export function createContextOnly(
  s: CanonicalSession,
  explicit?: unknown,
): CanonicalSession {
  assertSession(s);
  if (s.security.profile === "context-only" && explicit === undefined)
    return JSON.parse(JSON.stringify(s));
  if (s.issues.some((i) => i.severity === "error") && explicit === undefined)
    throw new Error(
      "Source context is ambiguous or missing resources; provide an explicit checkpoint",
    );
  let cp: SemanticCheckpoint;
  if (explicit !== undefined) {
    assertCheckpoint(explicit);
    cp = JSON.parse(JSON.stringify(explicit));
    cp.extraction = "explicit";
  } else cp = extract(s);
  if (s.pendingTools.length && !cp.risks.includes(unknownRisk))
    cp.risks.push(unknownRisk);
  if (s.security.profile === "context-only")
    for (const risk of s.checkpoint!.risks)
      if (!cp.risks.includes(risk)) cp.risks.push(risk);
  if (s.issues.some((i) => i.severity === "error"))
    cp.risks.push(
      "Source context had unsupported semantics or missing resources; this explicit checkpoint is a manual replacement, not a verified reconstruction.",
    );
  assertCheckpoint(cp);
  // Digest identifies only the semantic content, not source commands, identifiers or byte transcript.
  const result = checkpointSession(
    cp,
    s.source.agent,
    s.cwd,
    sha256(JSON.stringify(cp)),
  );
  assertContextOnly(result);
  return result;
}
