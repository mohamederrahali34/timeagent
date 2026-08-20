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
  const root = await mkdtemp(path.join(tmpdir(), "timeagent-recovery-"));
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

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });
}

async function killProcess(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // It may already have exited as its parent was terminated.
  }
}

test("recovers a forcibly interrupted session from a second process", async () => {
  const root = await repository();
  let cli: ChildProcess | undefined;
  let agentPid: number | undefined;
  try {
    await writeFile(path.join(root, "a.txt"), "committed");
    await writeFile(path.join(root, "deleted.txt"), "contenu supprimé");
    await execFileAsync("git", ["add", "a.txt", "deleted.txt"], { cwd: root });
    await execFileAsync("git", ["-c", "user.name=TimeAgent Test", "-c", "user.email=test@timeagent.local", "commit", "-m", "initial"], { cwd: root });
    await writeFile(path.join(root, "a.txt"), "mon travail non commité");

    const script = [
      "const fs=require('node:fs');",
      "fs.writeFileSync('a.txt','modification agent');",
      "fs.writeFileSync('created.txt','créé pendant la session');",
      "fs.rmSync('deleted.txt');",
      "fs.writeFileSync('agent.pid',String(process.pid));",
      "fs.writeFileSync('ready.marker','ready');",
      "setInterval(()=>{},1000);",
    ].join("");
    cli = spawn(process.execPath, [cliPath, "run", process.execPath, "-e", script], {
      cwd: root,
      stdio: "ignore",
    });

    await waitFor(path.join(root, ".timeagent", "pending", "session.json"));
    await waitFor(path.join(root, "ready.marker"));
    agentPid = Number(await readFile(path.join(root, "agent.pid"), "utf8"));
    assert.equal(cli.kill("SIGKILL"), true);
    await waitForExit(cli);
    await killProcess(agentPid);

    assert.equal(await exists(path.join(root, ".timeagent", "pending", "before.json")), true);
    assert.equal(await exists(path.join(root, ".timeagent", "last")), false);

    await writeFile(path.join(root, "after-crash.txt"), "changement postérieur");
    let refusalOutput = "";
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "undo"], { cwd: root, encoding: "utf8" }),
      (error: unknown) => {
        const failure = error as { stdout?: string; stderr?: string };
        refusalOutput = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
        return /Interrupted TimeAgent session/.test(refusalOutput) && /Recovery cancelled/.test(refusalOutput);
      },
    );
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "modification agent");
    assert.equal(await exists(path.join(root, ".timeagent", "pending")), true);
    assert.match(refusalOutput, /Created: 4/);
    assert.match(refusalOutput, /Modified: 1/);
    assert.match(refusalOutput, /Deleted: 1/);

    const { stdout: statusOutput } = await execFileAsync(process.execPath, [cliPath, "status"], { cwd: root, encoding: "utf8" });
    assert.match(statusOutput, /State: interrupted/);
    assert.match(statusOutput, /Recovery checkpoint: available/);
    assert.match(statusOutput, /Undo available: yes/);

    await execFileAsync(process.execPath, [cliPath, "undo", "--yes"], { cwd: root });
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "mon travail non commité");
    assert.equal(await readFile(path.join(root, "deleted.txt"), "utf8"), "contenu supprimé");
    assert.equal(await exists(path.join(root, "created.txt")), false);
    assert.equal(await exists(path.join(root, "after-crash.txt")), false);
    assert.equal(await exists(path.join(root, ".timeagent", "pending")), false);
  } finally {
    if (cli && cli.exitCode === null && cli.signalCode === null) cli.kill("SIGKILL");
    if (agentPid) await killProcess(agentPid);
    await rm(root, { recursive: true, force: true });
  }
});

test("status covers absent, completed, and invalid pending sessions", async () => {
  const root = await repository();
  try {
    const noSession = await execFileAsync(process.execPath, [cliPath, "status"], { cwd: root, encoding: "utf8" });
    assert.match(noSession.stdout, /No restorable TimeAgent session/);

    await execFileAsync(process.execPath, [cliPath, "run", process.execPath, "-e", "require('node:fs').writeFileSync('new.txt','x')"], { cwd: root });
    const completed = await execFileAsync(process.execPath, [cliPath, "status"], { cwd: root, encoding: "utf8" });
    assert.match(completed.stdout, /State: completed/);
    assert.match(completed.stdout, /Files created: 1/);
    assert.match(completed.stdout, /Undo available: yes/);

    await execFileAsync(process.execPath, [cliPath, "undo", "--yes"], { cwd: root });
    await mkdir(path.join(root, ".timeagent", "pending"), { recursive: true });
    await writeFile(path.join(root, ".timeagent", "pending", "session.json"), "{json tronqué");
    await writeFile(path.join(root, "safe.txt"), "ne pas modifier");
    const invalid = await execFileAsync(process.execPath, [cliPath, "status"], { cwd: root, encoding: "utf8" });
    assert.match(invalid.stdout, /invalid recovery checkpoint detected/i);
    assert.match(invalid.stdout, /Undo available: no/);
    await assert.rejects(execFileAsync(process.execPath, [cliPath, "undo", "--yes"], { cwd: root }));
    assert.equal(await readFile(path.join(root, "safe.txt"), "utf8"), "ne pas modifier");
    assert.equal(await exists(path.join(root, ".timeagent", "pending")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a checkpoint belonging to another repository", async () => {
  const root = await repository();
  try {
    const pending = path.join(root, ".timeagent", "pending");
    await mkdir(path.join(pending, "files"), { recursive: true });
    await writeFile(path.join(pending, "before.json"), "[]");
    await writeFile(path.join(pending, "session.json"), JSON.stringify({
      version: 2,
      sessionId: "foreign-session",
      repositoryRoot: path.join(await realpath(root), "autre-depot"),
      command: "agent",
      args: [],
      startedAt: new Date().toISOString(),
      ownerPid: 2147483647,
    }));
    await writeFile(path.join(root, "safe.txt"), "intact");

    const status = await execFileAsync(process.execPath, [cliPath, "status"], { cwd: root, encoding: "utf8" });
    assert.match(status.stdout, /different repository/);
    assert.match(status.stdout, /Undo available: no/);
    await assert.rejects(execFileAsync(process.execPath, [cliPath, "undo", "--yes"], { cwd: root }));
    assert.equal(await readFile(path.join(root, "safe.txt"), "utf8"), "intact");
    assert.equal(await exists(pending), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
