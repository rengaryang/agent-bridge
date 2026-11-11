import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  access,
  realpath,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { decodeText } from "../src/adapters/index.js";
import { encodeBundle } from "../src/core/bundle.js";
import {
  compileNative,
  importNative,
  verifyNative,
  runNativeWorker,
} from "../src/native/index.js";
const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0))
    await rm(r, { recursive: true, force: true });
});
const input = () =>
  decodeText(
    "pi",
    [
      { type: "session", version: 3, id: "source-id", cwd: "/source" },
      {
        type: "message",
        id: "u",
        parentId: null,
        message: {
          role: "user",
          content: "Do not execute any historical commands.",
        },
      },
      {
        type: "message",
        id: "a",
        parentId: "u",
        message: {
          role: "assistant",
          provider: "openai",
          api: "openai-responses",
          model: "historical-model",
          timestamp: 1,
          content: [
            { type: "text", text: "We decided to use a canonical IR." },
            {
              type: "toolCall",
              id: "call",
              name: "bash",
              arguments: { command: "touch should-not-exist" },
            },
          ],
        },
      },
      {
        type: "message",
        id: "t",
        parentId: "a",
        message: {
          role: "toolResult",
          toolName: "bash",
          toolCallId: "call",
          content: [{ type: "text", text: "not run" }],
          isError: true,
        },
      },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n"),
  );
describe("native compiler", () => {
  it("preserves user/assistant roles but neutralizes tool protocol", () => {
    const compiled = compileNative(input());
    expect(compiled.messages.map((m) => m.role)).toEqual([
      "custom",
      "user",
      "assistant",
      "custom",
    ]);
    expect(JSON.stringify(compiled.messages)).not.toContain(
      '"type":"toolCall"',
    );
    expect(compiled.losses).toContain("tool-protocol-to-inert-history");
  });
  it("blocks nonportable ambiguous input and Codex native import", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "abridge-native-"));
    roots.push(root);
    await expect(
      importNative(encodeBundle(input()), {
        to: "codex",
        cwd: root,
        out: root,
      }),
    ).rejects.toThrow(/Codex/);
  });
});
describe("native SDK cold restore", () => {
  it.each(["pi", "omp"] as const)(
    "writes %s, cold opens, appends synthetic user and cold opens again",
    async (target) => {
      const root = await mkdtemp(path.join(tmpdir(), "abridge-native-"));
      roots.push(root);
      const bytes = encodeBundle(input());
      const imported = await importNative(bytes, {
        to: target,
        cwd: root,
        out: root,
      });
      expect(imported.receipt.status).toBe("NATIVE_CONTEXT_VERIFIED");
      expect(imported.receipt.nativeSessionId).not.toBe("source-id");
      expect(imported.receipt.verification.modelInvocation).toBe(false);
      await expect(
        access(path.join(root, "should-not-exist")),
      ).rejects.toThrow();
      const verified = await verifyNative(imported.directory);
      expect(verified.contextPrefixIntact).toBe(true);
      expect(
        (await importNative(bytes, { to: target, cwd: root, out: root }))
          .reused,
      ).toBe(true);
      const before = await readFile(imported.receipt.sessionFile);
      await runNativeWorker(target, {
        operation: "append-test-user",
        root: imported.directory,
        sessionFile: imported.receipt.sessionFile,
        cwd: root,
        text: "Synthetic next user turn; no model invoked.",
      });
      const next = await verifyNative(imported.directory);
      expect(next.additionalMessages).toBe(1);
      expect(
        (await readFile(imported.receipt.sessionFile)).subarray(
          0,
          before.length,
        ),
      ).toEqual(before);
      expect(
        (await importNative(bytes, { to: target, cwd: root, out: root }))
          .reused,
      ).toBe(true);
    },
    30000,
  );
});
describe("cross-agent native directions", () => {
  it.each([
    ["pi", "omp"],
    ["omp", "pi"],
    ["codex", "pi"],
    ["codex", "omp"],
  ] as const)(
    "%s -> %s keeps native context after cold open",
    async (from, to) => {
      const root = await mkdtemp(path.join(tmpdir(), "abridge-native-"));
      roots.push(root);
      const records =
        from === "codex"
          ? [
              {
                type: "session_meta",
                payload: { id: "foreign", cwd: "/source" },
              },
              {
                type: "response_item",
                payload: {
                  type: "message",
                  id: "m1",
                  role: "user",
                  content: [
                    {
                      type: "input_text",
                      text: "Goal: keep the migration read-only",
                    },
                  ],
                },
              },
              {
                type: "response_item",
                payload: {
                  type: "message",
                  id: "m2",
                  role: "assistant",
                  content: [
                    {
                      type: "output_text",
                      text: "Decision: use an independent native session",
                    },
                  ],
                },
              },
            ]
          : [
              { type: "session", version: 3, id: "foreign", cwd: "/source" },
              {
                type: "message",
                id: "u",
                parentId: null,
                message: {
                  role: "user",
                  content: "Goal: keep the migration read-only",
                },
              },
              {
                type: "message",
                id: "a",
                parentId: "u",
                message: {
                  role: "assistant",
                  content: [
                    {
                      type: "text",
                      text: "Decision: use an independent native session",
                    },
                  ],
                },
              },
            ];
      const session = decodeText(
        from,
        records.map((x) => JSON.stringify(x)).join("\n"),
      );
      const result = await importNative(encodeBundle(session), {
        to,
        cwd: root,
        out: root,
      });
      const cold = await verifyNative(result.directory);
      expect(cold.additionalMessages).toBe(0);
      expect(cold.receipt.importedContext.map((x) => x.role)).toEqual([
        "custom",
        "user",
        "assistant",
      ]);
      expect(
        cold.receipt.mapping.filter((x) => x.sourceEventId !== null),
      ).toHaveLength(2);
    },
    30000,
  );
});
describe("native CLI and safety", () => {
  const cli = (args: string[]) =>
    JSON.parse(
      execFileSync(process.execPath, ["dist/cli.js", ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  it.each(["pi", "omp"] as const)(
    "CLI structured import %s stays idempotent and validates prefix",
    async (target) => {
      const root = await mkdtemp(path.join(tmpdir(), "abridge-native-"));
      roots.push(root);
      const fp = path.join(root, "source.acx");
      await writeFile(fp, encodeBundle(input()));
      expect(
        cli(["plan", fp, "--to", target, "--cwd", root, "--mode", "structured"])
          .modelInvocation,
      ).toBe(false);
      const args = [
        "import",
        fp,
        "--to",
        target,
        "--cwd",
        root,
        "--out",
        root,
        "--mode",
        "structured",
      ];
      const result = cli(args);
      expect(cli(args).reused).toBe(true);
      expect(cli(["verify", result.directory]).contextPrefixIntact).toBe(true);
      expect(cli(["resume", result.directory]).modelContinuationVerified).toBe(
        false,
      );
      const text = await readFile(result.receipt.sessionFile, "utf8");
      await writeFile(
        result.receipt.sessionFile,
        text.replace("canonical IR", "corrupted IR"),
      );
      expect(() => cli(["verify", result.directory])).toThrow();
    },
    30000,
  );
  it("blocks source semantic errors and resource omissions", () => {
    const s = input();
    s.issues.push({
      severity: "error",
      code: "UNKNOWN_CONTEXT_EFFECT",
      message: "unknown",
    });
    expect(() => compileNative(s)).toThrow();
  });
  it("preserves source metadata but never activates native runtime instructions", () => {
    const s = input();
    const messages = compileNative(s).messages;
    expect(
      messages.some((m) =>
        ["system", "developer", "toolResult"].includes(m.role),
      ),
    ).toBe(false);
    expect(messages.find((m) => m.role === "assistant")?.metadata?.model).toBe(
      "historical-model",
    );
  });
  it("rejects native session path outside owned staging root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "abridge-native-"));
    roots.push(root);
    const file = path.join(root, "outside.jsonl");
    await writeFile(file, "{}");
    await expect(
      runNativeWorker("pi", {
        operation: "inspect",
        root: await realpath(root),
        cwd: await realpath(root),
        sessionFile: await realpath(file),
      }),
    ).rejects.toThrow(/outside/);
  });
});
