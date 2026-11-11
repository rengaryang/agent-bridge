export type AgentName = "pi" | "omp" | "codex";
export type TransferProfile = "archive" | "context-only";
export interface SemanticCheckpoint {
  schemaVersion: 1;
  goals: string[];
  constraints: string[];
  background: string[];
  facts: string[];
  decisions: string[];
  artifacts: string[];
  progress: string[];
  nextSteps: string[];
  risks: string[];
  reviewRequired: true;
  extraction: "explicit" | "labelled-extract";
}
export type RecordValue = Record<string, unknown>;
export interface Issue {
  severity: "warning" | "error";
  code: string;
  message: string;
  eventId?: string;
}
export interface CanonicalEvent {
  id: string;
  parentId: string | null;
  ordinal: number;
  kind: string;
  raw: RecordValue;
}
export interface ContextMessage {
  eventId: string;
  role: "user" | "assistant" | "tool" | "summary" | "historical";
  text: string;
  sourceOrdinal: number;
}
export interface PendingTool {
  callId: string;
  eventId: string;
  name: string;
  status: "outcomeUnknown";
}
export interface CanonicalSession {
  schemaVersion: 1;
  source: {
    agent: AgentName;
    sessionId: string;
    formatVersion: number | null;
    digest: string;
    path?: string;
  };
  title: string | null;
  cwd: string;
  selectedLeaf: string | null;
  leafEvidence: "explicit" | "lastPersistedRecord";
  events: CanonicalEvent[];
  context: ContextMessage[];
  pendingTools: PendingTool[];
  issues: Issue[];
  checkpoint?: SemanticCheckpoint;
  security: {
    profile: "unredacted-local" | "portable-redacted" | "context-only";
    policy: string;
  };
}
export interface DecodeOptions {
  leaf?: string;
  path?: string;
}
export interface Handoff {
  text: string;
  included: string[];
  omitted: string[];
  estimatedTokens: number;
}
export interface MigrationOptions {
  to: AgentName;
  cwd: string;
  mode: "auto" | "handoff" | "structured";
  budget?: number;
}
export interface MigrationPlan {
  schemaVersion: 1;
  status: "PREPARED";
  target: AgentName;
  cwd: string;
  mode: "handoff";
  nativeResumeVerified: false;
  sourceDigest: string;
  idempotencyKey: string;
  handoff: Handoff;
  issues: Issue[];
}
export interface Receipt {
  schemaVersion: 1;
  status: "PREPARED";
  idempotencyKey: string;
  target: AgentName;
  cwd: string;
  nativeResumeVerified: false;
  handoffSha256: string;
  files: { path: string; sha256: string; size: number }[];
  resume: {
    command: string;
    args: string[];
    automatic: false;
    instructions: string;
  };
}
