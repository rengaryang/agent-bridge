import type {
  AgentName,
  CanonicalSession,
  DecodeOptions,
} from "../core/types.js";
import { decodeTree } from "./tree.js";
import { decodeCodex } from "./codex.js";
export function decodeText(
  agent: AgentName,
  text: string,
  options: DecodeOptions = {},
): CanonicalSession {
  return agent === "codex"
    ? decodeCodex(text, options)
    : decodeTree(agent, text, options);
}
