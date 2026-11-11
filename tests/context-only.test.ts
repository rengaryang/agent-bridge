import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { unzipSync, strFromU8, zipSync, strToU8 } from "fflate";
import { decodeText } from "../src/adapters/index.js";
import { encodeBundle, decodeBundle } from "../src/core/bundle.js";
import { createContextOnly, assertCheckpoint } from "../src/core/checkpoint.js";
import {
  compileNative,
  importNative,
  verifyNative,
} from "../src/native/index.js";
import { compileHandoff } from "../src/core/handoff.js";
import { sha256 } from "../src/core/util.js";
const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0))
    await rm(r, { recursive: true, force: true });
});
const native = () =>
  [
    {
      type: "session",
      version: 3,
      id: "ORIGINAL_SESSION_SECRET",
      cwd: "/repo",
    },
    {
      type: "message",
      id: "u",
      parentId: null,
      message: {
        role: "user",
        content:
          "Goal: build a migration tool\nConstraint: no command replay\nBackground: local coding agents",
      },
    },
    {
      type: "message",
      id: "a",
      parentId: "u",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "PROCESS_MARKER: running checks now" },
          {
            type: "toolCall",
            id: "PENDING_CALL_SECRET",
            name: "bash",
            arguments: { command: "EXECUTION_MARKER touch file" },
          },
        ],
      },
    },
    {
      type: "custom",
      id: "start",
      parentId: "a",
      customType: "tool_execution_start",
      data: { toolCallId: "PENDING_CALL_SECRET" },
    },
    {
      type: "message",
      id: "d",
      parentId: "start",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Conclusion: use semantic checkpoints\nFact: local CLI is available\nArtifact: README.md\nNext step: verify target compatibility",
          },
        ],
      },
    },
  ]
    .map((x) => JSON.stringify(x))
    .join("\n");
const source = () => decodeText("pi", native());
const explicit = () => ({
  schemaVersion: 1,
  goals: ["Build migration tool"],
  constraints: ["No replay"],
  background: [],
  facts: [],
  decisions: ["Use checkpoints"],
  artifacts: ["README.md"],
  progress: ["Native storage exists"],
  nextSteps: ["Verify models"],
  risks: [],
  reviewRequired: true,
  extraction: "explicit",
});
const all = (bytes: Uint8Array) =>
  Object.entries(unzipSync(bytes))
    .map(([n, b]) => n + "\n" + strFromU8(b))
    .join("\n");
const forbidden = [
  "EXECUTION_MARKER",
  "PROCESS_MARKER",
  "PENDING_CALL_SECRET",
  "ORIGINAL_SESSION_SECRET",
  "tool_execution_start",
  '"type":"toolCall"',
];
describe("context-only checkpoint", () => {
  it("extracts labelled semantics, not execution history", () => {
    const s = createContextOnly(source());
    const text = JSON.stringify(s);
    for (const marker of forbidden) expect(text).not.toContain(marker);
    expect(s.checkpoint?.goals).toEqual(["build a migration tool"]);
    expect(s.checkpoint?.decisions).toEqual(["use semantic checkpoints"]);
    expect(s.checkpoint?.reviewRequired).toBe(true);
    expect(s.checkpoint?.risks.join(" ")).toMatch(/unknown/i);
    expect(s.events).toHaveLength(1);
    expect(s.pendingTools).toHaveLength(0);
  });
  it("never copies unlabeled final prose as a reliable conclusion", () => {
    const s = decodeText(
      "pi",
      [
        { type: "session", version: 3, id: "s", cwd: "/repo" },
        {
          type: "message",
          id: "u",
          parentId: null,
          message: { role: "user", content: "please continue" },
        },
        {
          type: "message",
          id: "a",
          parentId: "u",
          message: {
            role: "assistant",
            content: "unstructured execution history",
          },
        },
      ]
        .map((x) => JSON.stringify(x))
        .join("\n"),
    );
    expect(() => createContextOnly(s)).toThrow(/checkpoint|goal/i);
  });
  it("uses explicit checkpoint and preserves unknown-action warning", () => {
    const s = createContextOnly(source(), explicit());
    expect(s.checkpoint?.goals).toEqual(["Build migration tool"]);
    expect(s.checkpoint?.risks.join(" ")).toMatch(/unknown/i);
  });
  it.each(["unknown extra", "tool process", "no goals"])(
    "rejects invalid explicit checkpoint: %s",
    (variant) => {
      const c: any = explicit();
      if (variant === "unknown extra") c.rawLog = "secret";
      if (variant === "tool process")
        c.decisions = ["[HISTORICAL TOOL RESULT bash] log"];
      if (variant === "no goals") c.goals = [];
      expect(() => assertCheckpoint(c)).toThrow();
    },
  );
  it("does not preserve reset-era or context-edit deleted facts", () => {
    const s = source();
    s.context = s.context.filter((c) => c.role !== "user");
    expect(() => createContextOnly(s)).toThrow();
  });
  it("applies actual reset and context edit before semantic extraction", () => {
    const s = decodeText(
      "omp",
      [
        { type: "session", version: 3, id: "s", cwd: "/repo" },
        {
          type: "message",
          id: "old",
          parentId: null,
          message: { role: "user", content: "Goal: OLD_GOAL" },
        },
        { type: "reset_boundary", id: "r", parentId: "old" },
        {
          type: "message",
          id: "u",
          parentId: "r",
          message: { role: "user", content: "Goal: CURRENT_GOAL" },
        },
        {
          type: "message",
          id: "a",
          parentId: "u",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Conclusion: DELETED_CONCLUSION" }],
          },
        },
        {
          type: "context_edit",
          id: "e",
          parentId: "a",
          targetId: "a",
          replacement: null,
        },
      ]
        .map((x) => JSON.stringify(x))
        .join("\n"),
    );
    const cp = createContextOnly(s);
    expect(cp.checkpoint?.goals).toEqual(["CURRENT_GOAL"]);
    expect(JSON.stringify(cp)).not.toContain("OLD_GOAL");
    expect(JSON.stringify(cp)).not.toContain("DELETED_CONCLUSION");
  });
  it("explicit replacement of unknown context retains a manual-review risk", () => {
    const s = source();
    s.issues.push({
      severity: "error",
      code: "UNKNOWN_CONTEXT_EFFECT",
      message: "SECRET_PROCESS_DIAGNOSTIC",
    });
    expect(() => createContextOnly(s)).toThrow();
    const minimal = createContextOnly(s, explicit());
    expect(minimal.checkpoint?.risks.join(" ")).toContain("manual replacement");
    expect(JSON.stringify(minimal)).not.toContain("SECRET_PROCESS_DIAGNOSTIC");
  });
  it("refuses to recreate removed history as archive", () => {
    const minimal = createContextOnly(source());
    expect(() => encodeBundle(minimal, { profile: "archive" })).toThrow();
  });
  it("extracts Chinese labels but excludes unmarked process prose", () => {
    const s = decodeText(
      "pi",
      [
        { type: "session", version: 3, id: "s", cwd: "/repo" },
        {
          type: "message",
          id: "u",
          parentId: null,
          message: {
            role: "user",
            content: "目标：语义迁移\n约束：只读源数据",
          },
        },
        {
          type: "message",
          id: "a",
          parentId: "u",
          message: {
            role: "assistant",
            content:
              "正在尝试命令，PROCESS_MARKER\n结论：使用检查点\n下一步：复核上下文",
          },
        },
      ]
        .map((x) => JSON.stringify(x))
        .join("\n"),
    );
    const cp = createContextOnly(s);
    expect(cp.checkpoint?.goals).toEqual(["语义迁移"]);
    expect(cp.checkpoint?.decisions).toEqual(["使用检查点"]);
    expect(JSON.stringify(cp)).not.toContain("PROCESS_MARKER");
  });
  it("retains only known fields and no source path/model metadata", () => {
    const s = source();
    s.source.path = "/private/process-path";
    const minimal = createContextOnly(s);
    expect(minimal.source.path).toBeUndefined();
    expect(JSON.stringify(minimal)).not.toContain("/private/process-path");
    expect(minimal.source.sessionId).toBe("semantic-checkpoint");
  });
});
describe("context-only ACX", () => {
  it("has no events.jsonl or raw archive and roundtrips", () => {
    const bytes = encodeBundle(source(), { profile: "context-only" });
    expect(Object.keys(unzipSync(bytes))).not.toContain("events.jsonl");
    expect(Object.keys(unzipSync(bytes))).toContain("checkpoint.json");
    for (const marker of forbidden) expect(all(bytes)).not.toContain(marker);
    const s = decodeBundle(bytes);
    expect(s.security.profile).toBe("context-only");
    expect(s.checkpoint?.decisions).toEqual(["use semantic checkpoints"]);
  });
  it("refuses mixed archive member even with valid manifest hashes", () => {
    const files = unzipSync(
      encodeBundle(source(), { profile: "context-only" }),
    );
    files["events.jsonl"] = strToU8("SECRET_RAW");
    const manifest = JSON.parse(strFromU8(files["manifest.json"]!));
    manifest.members.push({
      path: "events.jsonl",
      size: 10,
      sha256: sha256("SECRET_RAW"),
    });
    files["manifest.json"] = strToU8(JSON.stringify(manifest));
    expect(() => decodeBundle(zipSync(files))).toThrow();
  });
  it("refuses inconsistent synthetic context even if checksums rewritten", () => {
    const files = unzipSync(
      encodeBundle(source(), { profile: "context-only" }),
    );
    const s = JSON.parse(strFromU8(files["session.json"]!));
    s.events[0].raw.extra = "PROCESS_MARKER";
    files["session.json"] = strToU8(JSON.stringify(s));
    const m = JSON.parse(strFromU8(files["manifest.json"]!));
    for (const member of m.members) {
      member.size = files[member.path].length;
      member.sha256 = sha256(files[member.path]);
    }
    files["manifest.json"] = strToU8(JSON.stringify(m));
    expect(() => decodeBundle(zipSync(files))).toThrow();
  });
  it("rejects manifest sidecar text even when hashes are valid", () => {
    const files = unzipSync(
      encodeBundle(source(), { profile: "context-only" }),
    );
    const m = JSON.parse(strFromU8(files["manifest.json"]!));
    m.raw = "SECRET_EXECUTION_HISTORY";
    files["manifest.json"] = strToU8(JSON.stringify(m));
    expect(() => decodeBundle(zipSync(files))).toThrow();
  });
  it("uses one semantic native record rather than restored source messages", () => {
    const s = decodeBundle(encodeBundle(source(), { profile: "context-only" }));
    expect(compileNative(s).messages).toHaveLength(1);
    expect(compileNative(s).messages[0]?.role).toBe("custom");
    expect(() => compileHandoff(s, 20)).toThrow(/budget/i);
  });
  it("keeps archive mode compatible", () => {
    const s = decodeBundle(encodeBundle(source()));
    expect(s.events.length).toBeGreaterThan(1);
    expect(Object.keys(unzipSync(encodeBundle(source())))).toContain(
      "events.jsonl",
    );
  });
});
describe("context-only CLI and native", () => {
  const cli = (args: string[]) =>
    JSON.parse(
      execFileSync(process.execPath, ["dist/cli.js", ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  it("converts archive on import without retaining its original bytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "abridge-context-"));
    roots.push(root);
    const file = path.join(root, "full.acx");
    await writeFile(file, encodeBundle(source()));
    const r = cli([
      "import",
      file,
      "--to",
      "codex",
      "--cwd",
      root,
      "--out",
      root,
      "--profile",
      "context-only",
      "--mode",
      "handoff",
    ]);
    const saved = await readFile(path.join(r.directory, "source.acx"));
    for (const marker of forbidden) expect(all(saved)).not.toContain(marker);
    expect(decodeBundle(saved).checkpoint).toBeDefined();
    for (const name of ["plan.json", "receipt.json", "handoff.md"]) {
      const text = await readFile(path.join(r.directory, name), "utf8");
      for (const marker of forbidden) expect(text).not.toContain(marker);
    }
    expect(cli(["verify", r.directory]).preparedIntegrityVerified).toBe(true);
  });
  it("export and migrate support explicit checkpoint and preserve source", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "abridge-context-"));
    roots.push(root);
    const file = path.join(root, "source.jsonl"),
      check = path.join(root, "checkpoint.json"),
      bundle = path.join(root, "minimal.acx");
    await writeFile(file, native());
    await writeFile(check, JSON.stringify(explicit()));
    cli([
      "export",
      "--from",
      "pi",
      "--session",
      file,
      "--out",
      bundle,
      "--profile",
      "context-only",
      "--checkpoint",
      check,
    ]);
    expect(decodeBundle(await readFile(bundle)).checkpoint?.extraction).toBe(
      "explicit",
    );
    expect(cli(["inspect", bundle]).checkpoint).toBeDefined();
    const r = cli([
      "migrate",
      "--from",
      "pi",
      "--session",
      file,
      "--to",
      "codex",
      "--cwd",
      root,
      "--out",
      root,
      "--profile",
      "context-only",
      "--checkpoint",
      check,
    ]);
    expect(r.receipt.status).toBe("PREPARED");
    expect(await readFile(file, "utf8")).toBe(native());
  });
  it.each([
    ["pi", "omp"],
    ["pi", "codex"],
    ["omp", "pi"],
    ["omp", "codex"],
    ["codex", "pi"],
    ["codex", "omp"],
  ] as const)(
    "context-only %s -> %s prepares a log-free checkpoint",
    async (from, to) => {
      const root = await mkdtemp(path.join(tmpdir(), "abridge-context-"));
      roots.push(root);
      const sourceFile = path.join(root, "source.jsonl");
      const value =
        from === "codex"
          ? [
              {
                type: "session_meta",
                payload: { id: "ORIGINAL_SESSION_SECRET", cwd: "/repo" },
              },
              {
                type: "response_item",
                payload: {
                  type: "message",
                  id: "u",
                  role: "user",
                  content: [
                    { type: "input_text", text: "Goal: context transfer" },
                  ],
                },
              },
              {
                type: "response_item",
                payload: {
                  type: "message",
                  id: "a",
                  role: "assistant",
                  content: [
                    {
                      type: "output_text",
                      text: "PROCESS_MARKER\nConclusion: portable checkpoint",
                    },
                  ],
                },
              },
            ]
              .map((x) => JSON.stringify(x))
              .join("\n")
          : native();
      await writeFile(sourceFile, value);
      const args = [
        "migrate",
        "--from",
        from,
        "--session",
        sourceFile,
        "--to",
        to,
        "--cwd",
        root,
        "--out",
        root,
        "--profile",
        "context-only",
        "--mode",
        "handoff",
      ];
      const r = cli(args);
      expect(cli(args).reused).toBe(true);
      for (const marker of forbidden)
        expect(
          all(await readFile(path.join(r.directory, "source.acx"))),
        ).not.toContain(marker);
    },
  );
  it("plan and structured import convert existing archive without retaining old bytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "abridge-context-"));
    roots.push(root);
    const file = path.join(root, "full.acx");
    await writeFile(file, encodeBundle(source()));
    const p = cli([
      "plan",
      file,
      "--to",
      "pi",
      "--cwd",
      root,
      "--profile",
      "context-only",
      "--mode",
      "structured",
    ]);
    expect(p.nativeContextMessages).toBe(1);
    const r = cli([
      "import",
      file,
      "--to",
      "pi",
      "--cwd",
      root,
      "--out",
      root,
      "--profile",
      "context-only",
      "--mode",
      "structured",
    ]);
    for (const marker of forbidden)
      expect(
        all(await readFile(path.join(r.directory, "source.acx"))),
      ).not.toContain(marker);
    expect(r.receipt.importedContext).toHaveLength(1);
    expect(cli(["verify", r.directory]).contextPrefixIntact).toBe(true);
  });
  it.each(["pi", "omp"] as const)(
    "native %s stores only checkpoint",
    async (to) => {
      const root = await mkdtemp(path.join(tmpdir(), "abridge-context-"));
      roots.push(root);
      const bytes = encodeBundle(source(), { profile: "context-only" });
      const r = await importNative(bytes, { to, cwd: root, out: root });
      expect(r.receipt.importedContext).toHaveLength(1);
      expect((await verifyNative(r.directory)).additionalMessages).toBe(0);
      for (const name of ["compilation.json", "receipt.json"]) {
        for (const marker of forbidden)
          expect(
            await readFile(path.join(r.directory, name), "utf8"),
          ).not.toContain(marker);
      }
      for (const marker of forbidden)
        expect(await readFile(r.receipt.sessionFile, "utf8")).not.toContain(
          marker,
        );
    },
    30000,
  );
});
