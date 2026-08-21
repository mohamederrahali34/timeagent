import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");

async function createRepository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "timeagent-cli-session-"));
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

test("run and undo work from separate CLI processes", async () => {
  const root = await createRepository();
  try {
    await writeFile(path.join(root, "modified.txt"), "modification utilisateur préexistante");
    await writeFile(path.join(root, "deleted.txt"), "à restaurer");

    const script = [
      "const fs=require('node:fs');",
      "fs.appendFileSync('modified.txt',' + agent');",
      "fs.writeFileSync('created.txt','créé par agent');",
      "fs.rmSync('deleted.txt');",
    ].join("");
    await execFileAsync(process.execPath, [cliPath, "run", process.execPath, "-e", script], { cwd: root });

    assert.equal(await exists(path.join(root, ".timeagent", "pending")), false);
    assert.equal(await exists(path.join(root, ".timeagent", "last", "manifest.json")), true);
    assert.equal(await exists(path.join(root, ".timeagent", "last", "before.json")), true);

    const { stdout } = await execFileAsync(process.execPath, [cliPath, "undo", "--yes"], { cwd: root });
    assert.match(stdout, /restored successfully/);
    assert.equal(await readFile(path.join(root, "modified.txt"), "utf8"), "modification utilisateur préexistante");
    assert.equal(await readFile(path.join(root, "deleted.txt"), "utf8"), "à restaurer");
    assert.equal(await exists(path.join(root, "created.txt")), false);
    assert.equal(await exists(path.join(root, ".timeagent", "last")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("undo from an existing parent directory removes only the created child file", async () => {
  const root = await createRepository();
  try {
    const sourceDirectory = path.join(root, "src");
    await mkdir(sourceDirectory);
    await writeFile(path.join(sourceDirectory, "app.ts"), "app");
    await writeFile(path.join(sourceDirectory, "config.ts"), "config");
    const script = "require('node:fs').writeFileSync('src/auth.ts','auth')";
    await execFileAsync(process.execPath, [cliPath, "run", process.execPath, "-e", script], { cwd: root });

    await execFileAsync(process.execPath, [cliPath, "undo", "--yes"], { cwd: sourceDirectory });
    assert.equal(await exists(sourceDirectory), true);
    assert.equal(await readFile(path.join(sourceDirectory, "app.ts"), "utf8"), "app");
    assert.equal(await readFile(path.join(sourceDirectory, "config.ts"), "utf8"), "config");
    assert.equal(await exists(path.join(sourceDirectory, "auth.ts")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("undo refuses before changes when cwd is inside a directory that must be removed", async () => {
  const root = await createRepository();
  try {
    await writeFile(path.join(root, "existing.txt"), "unchanged");
    const script = [
      "const fs=require('node:fs');",
      "fs.mkdirSync('created-dir');",
      "fs.writeFileSync('created-dir/file.txt','created');",
    ].join("");
    await execFileAsync(process.execPath, [cliPath, "run", process.execPath, "-e", script], { cwd: root });
    const createdDirectory = path.join(root, "created-dir");

    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "undo", "--yes"], { cwd: createdDirectory, encoding: "utf8" }),
      (error: unknown) => /current working directory is inside a directory that must be removed/.test((error as { stderr?: string }).stderr ?? ""),
    );
    assert.equal(await readFile(path.join(root, "existing.txt"), "utf8"), "unchanged");
    assert.equal(await readFile(path.join(createdDirectory, "file.txt"), "utf8"), "created");
    assert.equal(await exists(path.join(root, ".timeagent", "last", "manifest.json")), true);

    await execFileAsync(process.execPath, [cliPath, "undo", "--yes"], { cwd: root });
    assert.equal(await exists(createdDirectory), false);
    assert.equal(await readFile(path.join(root, "existing.txt"), "utf8"), "unchanged");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a long-running command stays pending and finalizes after exit", async () => {
  const root = await createRepository();
  try {
    await writeFile(path.join(root, "long.txt"), "avant");
    const script = "setTimeout(()=>require('node:fs').writeFileSync('long.txt','après'),300)";
    const cli = spawn(process.execPath, [cliPath, "run", process.execPath, "-e", script], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const pendingBefore = path.join(root, ".timeagent", "pending", "before.json");
    for (let attempt = 0; attempt < 100 && !(await exists(pendingBefore)); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(await exists(pendingBefore), true);
    assert.equal(await exists(path.join(root, ".timeagent", "last")), false);

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      cli.once("error", reject);
      cli.once("close", resolve);
    });
    assert.equal(exitCode, 0);
    assert.equal(await exists(path.join(root, ".timeagent", "pending")), false);
    assert.equal(await exists(path.join(root, ".timeagent", "last", "manifest.json")), true);

    await execFileAsync(process.execPath, [cliPath, "undo"], { cwd: root });
    assert.equal(await readFile(path.join(root, "long.txt"), "utf8"), "avant");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an interceptable signal during an interactive command finalizes the checkpoint", { skip: process.platform === "win32" }, async () => {
  const root = await createRepository();
  try {
    await writeFile(path.join(root, "interactive.txt"), "avant");
    const script = [
      "require('node:fs').writeFileSync('interactive.txt','pendant');",
      "setInterval(()=>{},1000);",
    ].join("");
    const cli = spawn(process.execPath, [cliPath, "run", process.execPath, "-e", script], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const changedFile = path.join(root, "interactive.txt");
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await readFile(changedFile, "utf8")) === "pendant") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(await readFile(changedFile, "utf8"), "pendant");
    assert.equal(await exists(path.join(root, ".timeagent", "pending", "before.json")), true);

    cli.kill("SIGTERM");
    await new Promise<void>((resolve, reject) => {
      cli.once("error", reject);
      cli.once("close", () => resolve());
    });

    assert.equal(await exists(path.join(root, ".timeagent", "pending")), false);
    assert.equal(await exists(path.join(root, ".timeagent", "last", "manifest.json")), true);
    await execFileAsync(process.execPath, [cliPath, "undo"], { cwd: root });
    assert.equal(await readFile(changedFile, "utf8"), "avant");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
