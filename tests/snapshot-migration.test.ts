import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readSnapshot } from "../src/core/snapshot.js";
import { decodeText } from "../src/adapters/index.js";
import {
  planMigration,
  installPrepared,
  verifyPrepared,
} from "../src/core/migration.js";
const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0))
    await rm(r, { recursive: true, force: true });
});
const text =
  JSON.stringify({ type: "session", version: 3, id: "s", cwd: "/repo" }) +
  "\n" +
  JSON.stringify({
    type: "message",
    id: "u",
    parentId: null,
    message: { role: "user", content: "goal" },
  });
it("records offline snapshot and source path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "abridge-unit-"));
  roots.push(root);
  const fp = path.join(root, "source");
  await writeFile(fp, text);
  const s = await readSnapshot("pi", fp);
  expect(s.source.path).toBe(fp);
  expect(s.issues.some((x) => x.code === "OFFLINE_SNAPSHOT")).toBe(true);
});
it("rejects invalid UTF8", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "abridge-unit-"));
  roots.push(root);
  const fp = path.join(root, "source");
  await writeFile(fp, Buffer.from([255, 254]));
  await expect(readSnapshot("pi", fp)).rejects.toThrow();
});
it("rejects receipt symlink", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "abridge-unit-"));
  roots.push(root);
  const p = planMigration(decodeText("pi", text), {
    to: "codex",
    cwd: root,
    mode: "handoff",
  });
  const installed = await installPrepared(p, root);
  await rm(path.join(installed.directory, "receipt.json"));
  await symlink(
    path.join(installed.directory, "plan.json"),
    path.join(installed.directory, "receipt.json"),
  );
  await expect(verifyPrepared(installed.directory)).rejects.toThrow(
    "Unsafe receipt",
  );
});
it("does not recover incomplete prepared output by overwriting", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "abridge-unit-"));
  roots.push(root);
  const p = planMigration(decodeText("pi", text), {
    to: "omp",
    cwd: root,
    mode: "handoff",
  });
  const installed = await installPrepared(p, root);
  await rm(path.join(installed.directory, "receipt.json"));
  await expect(installPrepared(p, root)).rejects.toThrow();
});
