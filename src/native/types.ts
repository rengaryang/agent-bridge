import type { NativeMessage } from "./compiler.js";
export type NativeAgent = "pi" | "omp";
export interface WorkerRequest {
  operation: "create" | "inspect" | "append-test-user";
  root: string;
  cwd: string;
  sessionFile?: string;
  messages?: NativeMessage[];
  text?: string;
}
export interface WorkerResult {
  sessionFile: string;
  sessionId: string;
  cwd: string;
  context: { role: string; text: string }[];
  entryIds: string[];
  mapping: { sourceEventId: string | null; targetEntryId: string }[];
  sdkVersion: string;
}
export interface NativeReceipt {
  schemaVersion: 2;
  status: "NATIVE_CONTEXT_VERIFIED";
  mode: "structured";
  target: NativeAgent;
  idempotencyKey: string;
  cwd: string;
  nativeSessionId: string;
  sessionFile: string;
  sdkVersion: string;
  importedContext: { role: string; text: string }[];
  mapping: { sourceEventId: string | null; targetEntryId: string }[];
  losses: string[];
  files: { path: string; sha256: string; size: number }[];
  verification: {
    storageColdRestore: true;
    contextProjection: true;
    modelInvocation: false;
    toolExecution: false;
    interactiveCli: false;
  };
  resume: { command: string; args: string[]; automatic: false };
}
