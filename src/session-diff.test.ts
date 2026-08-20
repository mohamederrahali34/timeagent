import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "timeagent-diff-"));
  await execFileAsync("git", ["init"], { cwd: root });
  return root;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(file: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await exists(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Délai dépassé en attendant ${file}`);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
  }
}

test("CLI diff summarizes a session, produces patches, and preserves undo", async () => {
  const root = await repository();
  try {
    await writeFile(path.join(root, "modified.txt"), "version commitée\n");
    await execFileAsync("git", ["add", "modified.txt"], { cwd: root });
    await execFileAsync("git", ["-c", "user.name=TimeAgent Test", "-c", "user.email=test@timeagent.local", "commit", "-m", "initial"], { cwd: root });
    await writeFile(path.join(root, "modified.txt"), "travail utilisateur préexistant\n");
    await writeFile(path.join(root, "untracked.txt"), "non suivi avant\n");
    await writeFile(path.join(root, ".gitignore"), "*.log\n");
    await writeFile(path.join(root, "ignored.log"), "ignoré avant\n");
    await writeFile(path.join(root, "deleted.txt"), "à restaurer\n");

    const script = [
      "const fs=require('node:fs');",
      "fs.writeFileSync('modified.txt','modification agent\\n');",
      "fs.writeFileSync('untracked.txt','non suivi modifié\\n');",
      "fs.writeFileSync('ignored.log','ignoré modifié\\n');",
      "fs.writeFileSync('created.txt','nouveau texte\\n');",
      "fs.writeFileSync('binary.bin',Buffer.from([0,1,2,3]));",
      "fs.rmSync('deleted.txt');",
    ].join("");
    await execFileAsync(process.execPath, [cliPath, "run", process.execPath, "-e", script], { cwd: root });

    const checkpoint = path.join(root, ".timeagent", "last", "manifest.json");
    assert.equal(await exists(checkpoint), true);
    const summary = await execFileAsync(process.execPath, [cliPath, "diff"], { cwd: root, encoding: "utf8" });
    assert.match(summary.stdout, /State: completed/);
    assert.match(summary.stdout, /Created \(2\)[\s\S]*binary\.bin[\s\S]*created\.txt/);
    assert.match(summary.stdout, /Modified \(3\)[\s\S]*ignored\.log[\s\S]*modified\.txt[\s\S]*untracked\.txt/);
    assert.match(summary.stdout, /Deleted \(1\)[\s\S]*deleted\.txt/);
    assert.match(summary.stdout, /Total: 6 files changed/);
    assert.equal(await exists(checkpoint), true);

    const patch = await execFileAsync(process.execPath, [cliPath, "diff", "--patch"], { cwd: root, encoding: "utf8" });
    assert.match(patch.stdout, /--- before\/modified\.txt/);
    assert.match(patch.stdout, /-travail utilisateur préexistant/);
    assert.match(patch.stdout, /\+modification agent/);
    assert.match(patch.stdout, /binary\.bin\r?\nBinary file changed/);
    assert.equal(await exists(checkpoint), true);

    await execFileAsync(process.execPath, [cliPath, "undo", "--yes"], { cwd: root });
    assert.equal(await readFile(path.join(root, "modified.txt"), "utf8"), "travail utilisateur préexistant\n");
    assert.equal(await readFile(path.join(root, "untracked.txt"), "utf8"), "non suivi avant\n");
    assert.equal(await readFile(path.join(root, "ignored.log"), "utf8"), "ignoré avant\n");
    assert.equal(await readFile(path.join(root, "deleted.txt"), "utf8"), "à restaurer\n");
    assert.equal(await exists(path.join(root, "created.txt")), false);
    assert.equal(await exists(path.join(root, "binary.bin")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("diff rejects an active session and compares an interrupted session with current state", async () => {
  const root = await repository();
  let cli: ChildProcess | undefined;
  let agentPid: number | undefined;
  try {
    await writeFile(path.join(root, "a.txt"), "avant");
    const script = [
      "const fs=require('node:fs');",
      "fs.writeFileSync('a.txt','pendant');",
      "fs.writeFileSync('created.txt','nouveau');",
      "fs.writeFileSync('agent.pid',String(process.pid));",
      "fs.writeFileSync('ready','ok');",
      "setInterval(()=>{},1000);",
    ].join("");
    cli = spawn(process.execPath, [cliPath, "run", process.execPath, "-e", script], { cwd: root, stdio: "ignore" });
    await waitFor(path.join(root, "ready"));
    agentPid = Number(await readFile(path.join(root, "agent.pid"), "utf8"));

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "diff"], { cwd: root, encoding: "utf8" }),
      (error: unknown) => /Session is still active/.test((error as { stderr?: string }).stderr ?? ""),
    );

    await stop(cli);
    try { process.kill(agentPid, "SIGKILL"); } catch {}
    const interrupted = await execFileAsync(process.execPath, [cliPath, "diff"], { cwd: root, encoding: "utf8" });
    assert.match(interrupted.stdout, /State: interrupted/);
    assert.match(interrupted.stdout, /was not finalized/);
    assert.match(interrupted.stdout, /Modified \(1\)[\s\S]*a\.txt/);
    assert.match(interrupted.stdout, /Created \(3\)/);
    assert.equal(await exists(path.join(root, ".timeagent", "pending")), true);
  } finally {
    if (cli) await stop(cli);
    if (agentPid) { try { process.kill(agentPid, "SIGKILL"); } catch {} }
    await rm(root, { recursive: true, force: true });
  }
});

test("diff rejects absent, corrupted, and foreign checkpoints", async () => {
  const root = await repository();
  try {
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "diff"], { cwd: root, encoding: "utf8" }),
      (error: unknown) => /No TimeAgent session/.test((error as { stderr?: string }).stderr ?? ""),
    );

    const pending = path.join(root, ".timeagent", "pending");
    await mkdir(pending, { recursive: true });
    await writeFile(path.join(pending, "session.json"), "{invalide");
    await writeFile(path.join(root, "safe.txt"), "intact");
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "diff"], { cwd: root, encoding: "utf8" }),
      (error: unknown) => /Invalid checkpoint/.test((error as { stderr?: string }).stderr ?? ""),
    );
    assert.equal(await readFile(path.join(root, "safe.txt"), "utf8"), "intact");

    await rm(pending, { recursive: true, force: true });
    await mkdir(path.join(pending, "files"), { recursive: true });
    await writeFile(path.join(pending, "before.json"), "[]");
    await writeFile(path.join(pending, "session.json"), JSON.stringify({
      version: 2,
      sessionId: "foreign",
      repositoryRoot: path.join(await realpath(root), "autre"),
      command: "agent",
      args: [],
      startedAt: new Date().toISOString(),
      ownerPid: 2147483647,
    }));
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "diff"], { cwd: root, encoding: "utf8" }),
      (error: unknown) => /different repository/.test((error as { stderr?: string }).stderr ?? ""),
    );
    assert.equal(await readFile(path.join(root, "safe.txt"), "utf8"), "intact");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
