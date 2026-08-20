import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { runAndTrack } from "./runner.js";
import { undoLast } from "./undo.js";

const execFileAsync = promisify(execFile);

async function inRepository(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "timeagent-undo-"));
  try {
    await execFileAsync("git", ["init"], { cwd: root });
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runScript(root: string, source: string): Promise<void> {
  await runAndTrack(process.execPath, ["-e", source], root);
}

async function doesNotExist(file: string): Promise<boolean> {
  try {
    await access(file);
    return false;
  } catch {
    return true;
  }
}

test("undo restores a modified file", () => inRepository(async (root) => {
  const file = path.join(root, "file.txt");
  await writeFile(file, "avant");
  await runScript(root, "require('node:fs').writeFileSync('file.txt','après')");
  await undoLast(root);
  assert.equal(await readFile(file, "utf8"), "avant");
}));

test("undo removes a file created during the session", () => inRepository(async (root) => {
  const file = path.join(root, "new.txt");
  await runScript(root, "require('node:fs').writeFileSync('new.txt','nouveau')");
  await undoLast(root);
  assert.equal(await doesNotExist(file), true);
}));

test("undo restores a file deleted during the session", () => inRepository(async (root) => {
  const file = path.join(root, "deleted.txt");
  await writeFile(file, "contenu original");
  await runScript(root, "require('node:fs').rmSync('deleted.txt')");
  await undoLast(root);
  assert.equal(await readFile(file, "utf8"), "contenu original");
}));

test("undo preserves a pre-existing user change", () => inRepository(async (root) => {
  const file = path.join(root, "user.ts");
  await writeFile(file, "modification utilisateur non commitée");
  await runScript(root, "require('node:fs').appendFileSync('user.ts',' + agent')");
  await undoLast(root);
  assert.equal(await readFile(file, "utf8"), "modification utilisateur non commitée");
}));

test("undo requires confirmation for later changes", () => inRepository(async (root) => {
  const file = path.join(root, "file.txt");
  await writeFile(file, "avant");
  await runScript(root, "require('node:fs').writeFileSync('file.txt','session')");
  await writeFile(file, "changement postérieur");

  let asked = false;
  await assert.rejects(
    undoLast(root, async (changes) => {
      asked = true;
      assert.deepEqual(changes.modified, ["file.txt"]);
      return false;
    }),
    /Files changed after/i,
  );
  assert.equal(asked, true);
  assert.equal(await readFile(file, "utf8"), "changement postérieur");

  await undoLast(root, async () => true);
  assert.equal(await readFile(file, "utf8"), "avant");
}));

test("undo restores an untracked file", () => inRepository(async (root) => {
  const file = path.join(root, "untracked.txt");
  await writeFile(file, "non suivi avant la session");
  await runScript(root, "require('node:fs').writeFileSync('untracked.txt','modifié')");
  await undoLast(root);
  assert.equal(await readFile(file, "utf8"), "non suivi avant la session");
}));

test("undo restores ignored files", () => inRepository(async (root) => {
  const file = path.join(root, "ignored.log");
  await writeFile(path.join(root, ".gitignore"), "*.log\n");
  await writeFile(file, "ignoré avant la session");
  await runScript(root, "require('node:fs').writeFileSync('ignored.log','modifié')");
  await undoLast(root);
  assert.equal(await readFile(file, "utf8"), "ignoré avant la session");
}));

test("undo fails clearly without a restorable snapshot", () => inRepository(async (root) => {
  await assert.rejects(undoLast(root), /No restorable TimeAgent checkpoint/);
}));
