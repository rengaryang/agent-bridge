import { describe, it, expect } from "vitest";
import { decodeText } from "../src/adapters/index.js";
const entry = (
  id: string,
  parentId: string | null,
  type: string,
  data: object = {},
) => ({ type, id, parentId, timestamp: "2026-01-01T00:00:00Z", ...data });
const msg = (
  id: string,
  parent: string | null,
  role: string,
  content: unknown,
) => entry(id, parent, "message", { message: { role, content } });
const tree = (records: unknown[]) =>
  [{ type: "session", version: 3, id: "source", cwd: "/repo" }, ...records]
    .map((x) => JSON.stringify(x))
    .join("\n");

describe("Pi / OMP effective context", () => {
  it("selects a branch without deleting archive", () => {
    const s = decodeText(
      "pi",
      tree([
        msg("u", null, "user", "goal"),
        msg("a", "u", "assistant", [{ type: "text", text: "A" }]),
        msg("b", "u", "assistant", [{ type: "text", text: "B" }]),
      ]),
      { leaf: "a" },
    );
    expect(s.events).toHaveLength(3);
    expect(s.context.map((x) => x.text)).toEqual(["goal", "A"]);
  });
  it("applies context edits and retains raw graph", () => {
    const s = decodeText(
      "pi",
      tree([
        msg("u", null, "user", "private"),
        msg("a", "u", "assistant", [{ type: "text", text: "done" }]),
        entry("e", "a", "context_edit", { targetId: "u", replacement: null }),
      ]),
    );
    expect(s.context.map((x) => x.text)).toEqual(["done"]);
    expect(s.events).toHaveLength(3);
  });
  it("handles compaction retained tail without duplicate summary", () => {
    const s = decodeText(
      "pi",
      tree([
        msg("u", null, "user", "old"),
        msg("a", "u", "assistant", [{ type: "text", text: "recent" }]),
        entry("c", "a", "compaction", {
          summary: "summary",
          firstKeptEntryId: "a",
        }),
        msg("n", "c", "user", "next"),
      ]),
    );
    expect(s.context.map((x) => x.text)).toEqual(["summary", "recent", "next"]);
  });
  it("handles title slot and reset boundary", () => {
    const text =
      JSON.stringify({ type: "title", title: "Demo" }) +
      "\n" +
      tree([
        msg("u", null, "user", "old"),
        entry("r", "u", "reset_boundary"),
        msg("n", "r", "user", "new"),
      ]);
    const s = decodeText("omp", text);
    expect(s.title).toBe("Demo");
    expect(s.context.map((x) => x.text)).toEqual(["new"]);
  });
  it.each(["broken-json", "duplicate", "cycle", "orphan"])(
    "rejects %s",
    (kind) => {
      const records =
        kind === "duplicate"
          ? [msg("u", null, "user", "a"), msg("u", null, "user", "b")]
          : kind === "cycle"
            ? [msg("u", "v", "user", "a"), msg("v", "u", "user", "b")]
            : [msg("u", "missing", "user", "a")];
      expect(() =>
        decodeText(
          "pi",
          kind === "broken-json" ? tree([]) + "\n{broken" : tree(records),
        ),
      ).toThrow();
    },
  );
  it("flags unresolved tools without inventing success", () => {
    const s = decodeText(
      "omp",
      tree([
        msg("u", null, "user", "goal"),
        msg("a", "u", "assistant", [
          {
            type: "toolCall",
            id: "call1",
            name: "bash",
            arguments: { command: "touch x" },
          },
        ]),
        entry("e", "a", "custom", {
          customType: "tool_execution_start",
          data: { toolCallId: "call1" },
        }),
      ]),
    );
    expect(s.pendingTools[0]?.status).toBe("outcomeUnknown");
  });
  it("marks unknown semantic event as blocker", () => {
    const s = decodeText(
      "pi",
      tree([
        msg("u", null, "user", "goal"),
        entry("x", "u", "new_context_magic", { text: "???" }),
      ]),
    );
    expect(
      s.issues.some(
        (x) => x.severity === "error" && x.code === "UNKNOWN_CONTEXT_EFFECT",
      ),
    ).toBe(true);
  });
});

describe("Codex rollout", () => {
  const wrap = (type: string, payload: object) => ({
    type,
    timestamp: "2026-01-01T00:00:00Z",
    payload,
  });
  const text = (records: unknown[]) =>
    [wrap("session_meta", { id: "codex-src", cwd: "/repo" }), ...records]
      .map((x) => JSON.stringify(x))
      .join("\n");
  it("preserves repeated user messages and deduplicates event mirror by identity", () => {
    const s = decodeText(
      "codex",
      text([
        wrap("response_item", {
          type: "message",
          id: "m1",
          role: "user",
          content: [{ type: "input_text", text: "again" }],
        }),
        wrap("event_msg", {
          type: "user_message",
          item_id: "m1",
          message: "again",
        }),
        wrap("response_item", {
          type: "message",
          id: "m2",
          role: "user",
          content: [{ type: "input_text", text: "again" }],
        }),
      ]),
    );
    expect(
      s.context.filter((x) => x.role === "user").map((x) => x.text),
    ).toEqual(["again", "again"]);
  });
  it("applies rollback without discarding archive", () => {
    const s = decodeText(
      "codex",
      text([
        wrap("event_msg", { type: "user_message", message: "one" }),
        wrap("event_msg", { type: "agent_message", message: "done" }),
        wrap("event_msg", { type: "user_message", message: "two" }),
        wrap("event_msg", { type: "thread_rolled_back", num_turns: 1 }),
      ]),
    );
    expect(s.context.map((x) => x.text)).toEqual(["one", "done"]);
    expect(s.events).toHaveLength(4);
  });
  it("blocks opaque-only compaction", () => {
    const s = decodeText(
      "codex",
      text([
        wrap("compacted", {
          replacement_history: [
            { type: "compaction", encrypted_content: "opaque" },
          ],
        }),
      ]),
    );
    expect(
      s.issues.some(
        (x) => x.code === "OPAQUE_COMPACTION" && x.severity === "error",
      ),
    ).toBe(true);
  });
});
