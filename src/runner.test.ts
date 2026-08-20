import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { runAndTrack } from "./runner.js";

const execFileAsync = promisify(execFile);

test("tracks a session without altering a pre-existing change", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "timeagent-"));
  try {
    await execFileAsync("git", ["init"], { cwd: directory });
    await writeFile(path.join(directory, "existing.txt"), "changement utilisateur");
    await writeFile(path.join(directory, "deleted.txt"), "à supprimer");

    const script = [
      "const fs=require('node:fs');",
      "fs.writeFileSync('created.txt','nouveau');",
      "fs.appendFileSync('existing.txt','\\nsession');",
      "fs.rmSync('deleted.txt');",
    ].join("");
    const result = await runAndTrack(process.execPath, ["-e", script], directory);

    assert.deepEqual(result.created, ["created.txt"]);
    assert.deepEqual(result.modified, ["existing.txt"]);
    assert.deepEqual(result.deleted, ["deleted.txt"]);
    assert.equal(await readFile(path.join(directory, "existing.txt"), "utf8"), "changement utilisateur\nsession");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a directory outside a Git repository", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "timeagent-no-git-"));
  try {
    await assert.rejects(runAndTrack(process.execPath, ["-e", ""], directory), /Git repository/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
