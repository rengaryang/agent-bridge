import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const cli = (args: string[]) =>
  JSON.parse(
    execFileSync(process.execPath, ["dist/cli.js", ...args], {
      encoding: "utf8",
    }),
  );
const native = (kind: string) =>
  kind === "codex"
    ? [
        { type: "session_meta", payload: { id: "source", cwd: "/repo" } },
        {
          type: "response_item",
          payload: {
            type: "message",
            id: "m1",
            role: "user",
            content: [
              { type: "input_text", text: "Implement safe session transfer" },
            ],
          },
        },
      ]
    : [
        { type: "session", version: 3, id: "source", cwd: "/repo" },
        {
          type: "message",
          id: "u",
          parentId: null,
          message: { role: "user", content: "Implement safe session transfer" },
        },
      ];
describe("CLI offline E2E", () => {
  it.each(["pi", "omp", "codex"])(
    "exports %s and prepares all other target directions idempotently",
    async (from) => {
      const root = await mkdtemp(path.join(tmpdir(), "abridge-test-"));
      roots.push(root);
      const source = path.join(root, "source.jsonl"),
        bundle = path.join(root, "session.acx");
      await writeFile(
        source,
        native(from)
          .map((x) => JSON.stringify(x))
          .join("\n"),
      );
      const original = await readFile(source);
      expect(
        cli(["export", "--from", from, "--session", source, "--out", bundle])
          .status,
      ).toBe("ARCHIVED");
      expect(cli(["inspect", bundle]).source.agent).toBe(from);
      for (const to of ["pi", "omp", "codex"].filter((x) => x !== from)) {
        const args = [
          "import",
          bundle,
          "--to",
          to,
          "--cwd",
          root,
          "--mode",
          "handoff",
          "--out",
          root,
        ];
        const first = cli(args);
        expect(first.receipt.status).toBe("PREPARED");
        expect(first.receipt.nativeResumeVerified).toBe(false);
        expect(
          await readFile(path.join(first.directory, "source.acx")),
        ).toEqual(await readFile(bundle));
        expect(cli(args).reused).toBe(true);
        expect(cli(["verify", first.directory]).nativeResumeVerified).toBe(
          false,
        );
        expect(cli(["resume", first.directory]).automatic).toBe(false);
      }
      expect(await readFile(source)).toEqual(original);
    },
  );
  it("rejects overwriting export and prepared tampering", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "abridge-test-"));
    roots.push(root);
    const source = path.join(root, "source.jsonl"),
      bundle = path.join(root, "session.acx");
    await writeFile(
      source,
      native("pi")
        .map((x) => JSON.stringify(x))
        .join("\n"),
    );
    cli(["export", "--from", "pi", "--session", source, "--out", bundle]);
    expect(() =>
      cli(["export", "--from", "pi", "--session", source, "--out", bundle]),
    ).toThrow();
    const result = cli([
      "import",
      bundle,
      "--to",
      "codex",
      "--cwd",
      root,
      "--mode",
      "handoff",
      "--out",
      root,
    ]);
    await writeFile(path.join(result.directory, "handoff.md"), "tampered");
    expect(() => cli(["verify", result.directory])).toThrow();
  });
});
