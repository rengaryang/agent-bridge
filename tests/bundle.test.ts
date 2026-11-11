import { describe, it, expect } from "vitest";
import { encodeBundle, decodeBundle } from "../src/core/bundle.js";
import { decodeText } from "../src/adapters/index.js";
import { compileHandoff } from "../src/core/handoff.js";
import { planMigration } from "../src/core/migration.js";
import { zipSync, strToU8, unzipSync } from "fflate";
const source = () =>
  decodeText(
    "pi",
    [
      { type: "session", version: 3, id: "s", cwd: "/repo" },
      {
        type: "message",
        id: "u",
        parentId: null,
        message: {
          role: "user",
          content: "goal sk-abcdefghijklmnop1234567890",
        },
      },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n"),
  );

describe("ACX archive", () => {
  it("round-trips with redaction and hashes", () => {
    const bytes = encodeBundle(source());
    const loaded = decodeBundle(bytes);
    expect(loaded.context[0]?.text).toContain("[REDACTED]");
    expect(JSON.stringify(loaded)).not.toContain("sk-abcdefghijklmnop");
  });
  it("blocks media and unknown content effects from migration", () => {
    const media = decodeText(
      "pi",
      [
        { type: "session", version: 3, id: "s", cwd: "/repo" },
        {
          type: "message",
          id: "u",
          parentId: null,
          message: { role: "user", content: [{ type: "image", data: "data" }] },
        },
      ]
        .map((x) => JSON.stringify(x))
        .join("\n"),
    );
    expect(() =>
      planMigration(media, { to: "omp", cwd: "/repo", mode: "handoff" }),
    ).toThrow();
  });
  it("drops sensitive opaque and reasoning blocks from portable events", () => {
    const s = source();
    s.events[0]!.raw.extra = {
      type: "thinking",
      thinking: "private reasoning",
      signature: "opaque",
    };
    expect(JSON.stringify(decodeBundle(encodeBundle(s)))).not.toContain(
      "private reasoning",
    );
  });
  it("rejects forged local ZIP uncompressed size before inflation", () => {
    const bytes = Buffer.from(encodeBundle(source()));
    const local = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    bytes.writeUInt32LE(0x7fffffff, local + 22);
    expect(() => decodeBundle(bytes)).toThrow();
  });
  it("detects tampering", () => {
    const files = unzipSync(encodeBundle(source()));
    files["session.json"] = strToU8("{}");
    expect(() => decodeBundle(zipSync(files))).toThrow();
  });
  it("rejects unsafe member and missing manifest", () => {
    expect(() => decodeBundle(zipSync({ "../evil": strToU8("x") }))).toThrow();
  });
  it("rejects unexpected undeclared members", () => {
    const files = unzipSync(encodeBundle(source()));
    files["extra.json"] = strToU8("x");
    expect(() => decodeBundle(zipSync(files))).toThrow();
  });
});
describe("handoff and planning", () => {
  it("records budget omissions without trimming archive", () => {
    const s = source();
    const h = compileHandoff(s, 16);
    expect(h.omitted.length).toBeGreaterThan(0);
    expect(s.context).toHaveLength(1);
  });
  it("never claims prepared handoff is native resume", () => {
    const p = planMigration(source(), {
      to: "codex",
      cwd: "/repo",
      mode: "handoff",
    });
    expect(p.status).toBe("PREPARED");
    expect(p.nativeResumeVerified).toBe(false);
  });
  it("refuses unsupported structured mode", () => {
    expect(() =>
      planMigration(source(), {
        to: "codex",
        cwd: "/repo",
        mode: "structured",
      }),
    ).toThrow(/structured/i);
  });
});
