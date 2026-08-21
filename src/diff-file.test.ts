import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "timeagent-diff-file-"));
  await execFileAsync("git", ["init"], { cwd: root });
  return root;
}

async function diffFile(root: string, file: string): Promise<Record<string, unknown>> {
  const result = await execFileAsync(process.execPath, [cliPath, "diff-file", file, "--json"], { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /\.timeagent[\\/]/);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

test("diff-file returns modified, created, deleted, binary, large, and spaced-path semantics", async () => {
  const root = await repository();
  try {
    await writeFile(path.join(root, "modified.txt"), "before modified");
    await writeFile(path.join(root, "deleted.txt"), "before deleted");
    const script = [
      "const fs=require('node:fs');",
      "fs.writeFileSync('modified.txt','after modified');",
      "fs.rmSync('deleted.txt');",
      "fs.writeFileSync('created file.txt','created content');",
      "fs.writeFileSync('binary.bin',Buffer.from([0,1,2]));",
      "fs.writeFileSync('large.txt','x'.repeat(1024*1024+1));",
    ].join("");
    await execFileAsync(process.execPath, [cliPath, "run", process.execPath, "-e", script], { cwd: root });

    const modified = await diffFile(root, "modified.txt");
    assert.equal(modified.changeType, "modified");
    assert.equal((modified.before as { content: string }).content, "before modified");
    assert.equal((modified.after as { content: string }).content, "after modified");

    const created = await diffFile(root, "created file.txt");
    assert.equal(created.changeType, "created");
    assert.deepEqual(created.before, { exists: false, contentAvailable: true, unavailableReason: null, content: null });
    assert.equal((created.after as { content: string }).content, "created content");

    const deleted = await diffFile(root, "deleted.txt");
    assert.equal(deleted.changeType, "deleted");
    assert.equal((deleted.before as { content: string }).content, "before deleted");
    assert.deepEqual(deleted.after, { exists: false, contentAvailable: true, unavailableReason: null, content: null });

    const binary = await diffFile(root, "binary.bin");
    assert.equal(binary.binary, true);
    assert.equal((binary.after as { content: unknown }).content, null);
    assert.equal((binary.after as { unavailableReason: string }).unavailableReason, "binary");

    const large = await diffFile(root, "large.txt");
    assert.equal((large.after as { contentAvailable: boolean }).contentAvailable, false);
    assert.equal((large.after as { unavailableReason: string }).unavailableReason, "too-large");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("diff-file rejects traversal, Windows/POSIX absolute paths, unchanged files, and invalid options", async () => {
  const root = await repository();
  try {
    await writeFile(path.join(root, "unchanged.txt"), "same");
    await execFileAsync(process.execPath, [cliPath, "run", process.execPath, "-e", "require('node:fs').writeFileSync('changed.txt','x')"], { cwd: root });
    for (const unsafe of ["../secret.txt", "/etc/passwd", "C:\\Windows\\win.ini"]) {
      await assert.rejects(execFileAsync(process.execPath, [cliPath, "diff-file", unsafe, "--json"], { cwd: root, encoding: "utf8" }),
        (error: unknown) => /Invalid repository-relative path|escapes the repository/.test((error as { stderr?: string }).stderr ?? ""));
    }
    await assert.rejects(execFileAsync(process.execPath, [cliPath, "diff-file", "unchanged.txt", "--json"], { cwd: root, encoding: "utf8" }),
      (error: unknown) => /not part of the current session diff/.test((error as { stderr?: string }).stderr ?? ""));
    await assert.rejects(execFileAsync(process.execPath, [cliPath, "diff-file", "changed.txt", "--text"], { cwd: root, encoding: "utf8" }),
      (error: unknown) => (error as { code?: number }).code === 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("diff-file rejects a changed symlink or junction whose target escapes the repository", async (context) => {
  const root = await repository();
  const outside = await mkdtemp(path.join(tmpdir(), "timeagent-outside-"));
  try {
    await writeFile(path.join(outside, "secret.txt"), "outside");
    try {
      await symlink(outside, path.join(root, "link-capability-check"), process.platform === "win32" ? "junction" : "dir");
      await rm(path.join(root, "link-capability-check"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") { context.skip("Creating links requires unavailable Windows privileges."); return; }
      throw error;
    }
    await execFileAsync(process.execPath, [cliPath, "run", process.execPath, "-e", "require('node:fs').symlinkSync(process.argv[1],'escape',process.platform==='win32'?'junction':'dir')", outside], { cwd: root });
    await assert.rejects(execFileAsync(process.execPath, [cliPath, "diff-file", "escape", "--json"], { cwd: root, encoding: "utf8" }),
      (error: unknown) => /Symlink target escapes the repository/.test((error as { stderr?: string }).stderr ?? ""));
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("diff-file rejects invalid and another-repository checkpoints", async () => {
  const source = await repository();
  const target = await repository();
  try {
    await execFileAsync(process.execPath, [cliPath, "run", process.execPath, "-e", "require('node:fs').writeFileSync('changed.txt','x')"], { cwd: source });
    await cp(path.join(source, ".timeagent"), path.join(target, ".timeagent"), { recursive: true });
    await assert.rejects(execFileAsync(process.execPath, [cliPath, "diff-file", "changed.txt", "--json"], { cwd: target, encoding: "utf8" }),
      (error: unknown) => /different repository/.test((error as { stderr?: string }).stderr ?? ""));

    await rm(path.join(target, ".timeagent"), { recursive: true, force: true });
    await mkdir(path.join(target, ".timeagent", "pending"), { recursive: true });
    await writeFile(path.join(target, ".timeagent", "pending", "session.json"), "{broken");
    await assert.rejects(execFileAsync(process.execPath, [cliPath, "diff-file", "changed.txt", "--json"], { cwd: target, encoding: "utf8" }),
      (error: unknown) => /Invalid checkpoint/.test((error as { stderr?: string }).stderr ?? ""));
  } finally { await rm(source, { recursive: true, force: true }); await rm(target, { recursive: true, force: true }); }
});

test("diff-file uses current repository content for an interrupted session", async () => {
  const root = await repository();
  try {
    await writeFile(path.join(root, "file.txt"), "before");
    await execFileAsync(process.execPath, [cliPath, "run", process.execPath, "-e", "require('node:fs').writeFileSync('file.txt','after run')"], { cwd: root });
    const metadata = path.join(root, ".timeagent");
    await rename(path.join(metadata, "last"), path.join(metadata, "pending"));
    await rm(path.join(metadata, "pending", "manifest.json"));
    await writeFile(path.join(root, "file.txt"), "current interrupted");

    const result = await diffFile(root, "file.txt");
    assert.equal(result.sessionState, "interrupted");
    assert.equal((result.warning as { code: string }).code, "interrupted-session");
    assert.equal((result.before as { content: string }).content, "before");
    assert.equal((result.after as { content: string }).content, "current interrupted");
    assert.equal(JSON.stringify(result).includes(".timeagent"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
