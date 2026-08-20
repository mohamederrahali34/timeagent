import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { undoLast } from "./undo.js";
import { captureSnapshot } from "./snapshot.js";

const execFileAsync = promisify(execFile);
const hash = "0".repeat(64);

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "timeagent-safety-"));
  await execFileAsync("git", ["init"], { cwd: root });
  return root;
}

async function writePending(root: string, before: unknown): Promise<void> {
  const pending = path.join(root, ".timeagent", "pending");
  await mkdir(path.join(pending, "files"), { recursive: true });
  await writeFile(path.join(pending, "before.json"), JSON.stringify(before));
  await writeFile(path.join(pending, "session.json"), JSON.stringify({
    version: 2,
    sessionId: "malicious-checkpoint",
    repositoryRoot: await realpath(root),
    command: "agent",
    args: [],
    startedAt: new Date().toISOString(),
    ownerPid: 2147483647,
  }));
}

test("rejects absolute and escaping checkpoint paths before restoration", async () => {
  for (const maliciousPath of ["../../outside.txt", "/absolute.txt", "C:\\absolute.txt"]) {
    const root = await repository();
    try {
      await writeFile(path.join(root, "safe.txt"), "safe");
      await writePending(root, [[maliciousPath, { kind: "file", hash, mode: 0o100644 }]]);
      await assert.rejects(undoLast(root, undefined, true), /Invalid path in checkpoint/);
      assert.equal(await readFile(path.join(root, "safe.txt"), "utf8"), "safe");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("rejects a symlink entry combined with a child path", async () => {
  const root = await repository();
  try {
    await writeFile(path.join(root, "safe.txt"), "safe");
    await writePending(root, [
      ["link", { kind: "symlink", hash, mode: 0o120777, linkTarget: "../outside" }],
      ["link/escape.txt", { kind: "file", hash, mode: 0o100644 }],
    ]);
    await assert.rejects(undoLast(root, undefined, true), /Conflicting checkpoint paths/);
    assert.equal(await readFile(path.join(root, "safe.txt"), "utf8"), "safe");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("excludes TimeAgent metadata case-insensitively on Windows", { skip: process.platform !== "win32" }, async () => {
  const root = await repository();
  try {
    await mkdir(path.join(root, ".TIMEAGENT"), { recursive: true });
    await writeFile(path.join(root, ".TIMEAGENT", "metadata.txt"), "metadata");
    const snapshot = await captureSnapshot(root);
    assert.equal([...snapshot.keys()].some((file) => file.toLowerCase().startsWith(".timeagent/")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
