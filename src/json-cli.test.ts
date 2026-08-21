import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "timeagent-json-"));
  await execFileAsync("git", ["init"], { cwd: root });
  return root;
}

async function jsonCommand(root: string, ...args: string[]): Promise<Record<string, unknown>> {
  const result = await execFileAsync(process.execPath, [cliPath, ...args], { cwd: root, encoding: "utf8" });
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /Last session:|State:|Created \(/);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

test("status --json represents no session without changing human output", async () => {
  const root = await repository();
  try {
    const value = await jsonCommand(root, "status", "--json");
    assert.equal(value.schemaVersion, 1);
    assert.equal((value.session as { state: string }).state, "none");
    assert.equal((value.session as { undoAvailable: boolean }).undoAvailable, false);
    const human = await execFileAsync(process.execPath, [cliPath, "status"], { cwd: root, encoding: "utf8" });
    assert.equal(human.stdout.trim(), "No restorable TimeAgent session.");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("completed status and diff JSON use stable fields and deterministic paths", async () => {
  const root = await repository();
  try {
    await writeFile(path.join(root, "modified.txt"), "before");
    await writeFile(path.join(root, "deleted.txt"), "delete me");
    const script = "const fs=require('node:fs');fs.writeFileSync('z-created.txt','new');fs.writeFileSync('modified.txt','after');fs.rmSync('deleted.txt')";
    await execFileAsync(process.execPath, [cliPath, "run", process.execPath, "-e", script], { cwd: root });

    const status = await jsonCommand(root, "status", "--json");
    assert.equal((status.session as { state: string }).state, "completed");
    assert.equal((status.session as { undoAvailable: boolean }).undoAvailable, true);
    assert.deepEqual(status.changes, { created: 1, modified: 1, deleted: 1 });

    const diff = await jsonCommand(root, "diff", "--json");
    assert.deepEqual((diff.files as Array<{ path: string }>).map((file) => file.path), ["deleted.txt", "modified.txt", "z-created.txt"]);
    assert.deepEqual((diff.files as Array<{ changeType: string }>).map((file) => file.changeType), ["deleted", "modified", "created"]);
    assert.deepEqual(diff.summary, { created: 1, modified: 1, deleted: 1, total: 3 });

    const human = await execFileAsync(process.execPath, [cliPath, "diff"], { cwd: root, encoding: "utf8" });
    assert.match(human.stdout, /Created \(1\)/);
    assert.match(human.stdout, /Modified \(1\)/);
    assert.match(human.stdout, /Deleted \(1\)/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("actions --json is structured, relative, redacted, and summarized", async () => {
  const root = await repository();
  try {
    await execFileAsync(process.execPath, [cliPath, "run", process.execPath, "-e", ""], { cwd: root });
    const last = path.join(root, ".timeagent", "last");
    const manifest = JSON.parse(await readFile(path.join(last, "manifest.json"), "utf8")) as { session: { sessionId: string } };
    await writeFile(path.join(last, "actions.json"), JSON.stringify([{
      id: "action-1",
      sessionId: manifest.session.sessionId,
      timestamp: "2026-01-01T00:00:00.000Z",
      command: "vercel",
      args: ["deploy", "--token", "private-value", "--prod"],
      cwd: root,
      category: "deployment",
      risk: "high",
      reversible: false,
      status: "denied",
    }]));
    const value = await jsonCommand(root, "actions", "--json");
    const action = (value.actions as Array<{ args: string[]; cwd: string }>)[0];
    assert.deepEqual(action.args, ["deploy", "--token", "[REDACTED]", "--prod"]);
    assert.equal(action.cwd, ".");
    assert.deepEqual(value.summary, { total: 1, highRisk: 1, critical: 0, denied: 1 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("status --json represents interrupted and invalid checkpoints", async () => {
  const root = await repository();
  try {
    await execFileAsync(process.execPath, [cliPath, "run", process.execPath, "-e", "require('node:fs').writeFileSync('new.txt','x')"], { cwd: root });
    const metadata = path.join(root, ".timeagent");
    await rename(path.join(metadata, "last"), path.join(metadata, "pending"));
    await rm(path.join(metadata, "pending", "manifest.json"));
    const interrupted = await jsonCommand(root, "status", "--json");
    assert.equal((interrupted.session as { state: string }).state, "interrupted");
    assert.equal((interrupted.session as { recoveryCheckpointAvailable: boolean }).recoveryCheckpointAvailable, true);

    await rm(path.join(metadata, "pending"), { recursive: true, force: true });
    await mkdir(path.join(metadata, "pending"), { recursive: true });
    await writeFile(path.join(metadata, "pending", "session.json"), "{broken");
    const invalid = await jsonCommand(root, "status", "--json");
    assert.equal((invalid.session as { state: string }).state, "invalid");
    assert.equal((invalid.session as { undoAvailable: boolean }).undoAvailable, false);
    assert.equal(typeof (invalid.session as { invalidReason: unknown }).invalidReason, "string");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("version and invalid options return meaningful results", async () => {
  const root = await repository();
  try {
    const version = await execFileAsync(process.execPath, [cliPath, "--version"], { cwd: root, encoding: "utf8" });
    assert.match(version.stdout, /^0\.2\.1\s*$/);
    await assert.rejects(execFileAsync(process.execPath, [cliPath, "status", "--unsupported"], { cwd: root, encoding: "utf8" }),
      (error: unknown) => (error as { code?: number; stderr?: string }).code === 2 && /Usage: timeagent/.test((error as { stderr?: string }).stderr ?? ""));
  } finally { await rm(root, { recursive: true, force: true }); }
});
