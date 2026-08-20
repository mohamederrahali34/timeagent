import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseRunInvocation } from "./cli-main.js";
import { executeCommand } from "./runner.js";

const execFileAsync = promisify(execFile);

test("parses a command without arguments", () => {
  assert.deepEqual(parseRunInvocation(["run", "outil"]), { command: "outil", args: [] });
});

test("preserves multiple distinct arguments", () => {
  assert.deepEqual(parseRunInvocation(["run", "outil", "un", "deux", "trois"]), {
    command: "outil",
    args: ["un", "deux", "trois"],
  });
});

test("preserves an argument containing spaces", () => {
  assert.deepEqual(parseRunInvocation(["run", "powershell", "-Command", "Write-Output HELLO WORLD"]), {
    command: "powershell",
    args: ["-Command", "Write-Output HELLO WORLD"],
  });
});

test("passes exact arguments to the child process", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "timeagent-args-"));
  try {
    const output = path.join(root, "args.json");
    const script = "require('node:fs').writeFileSync(process.argv[1],JSON.stringify(process.argv.slice(2)))";
    const result = await executeCommand(process.execPath, ["-e", script, output, "un", "deux mots", "trois"], root);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), ["un", "deux mots", "trois"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("passes through the child process exit code", async () => {
  const result = await executeCommand(process.execPath, ["-e", "process.exit(37)"], process.cwd());
  assert.equal(result.exitCode, 37);
  assert.equal(result.signal, null);
});

test("PowerShell receives -Command as one argument on Windows", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(path.join(process.cwd(), ".test-powershell-"));
  try {
    const result = await executeCommand(
      "powershell.exe",
      ["-NoProfile", "-Command", "'test avec espaces' | Out-File -Encoding utf8 nouveau.txt"],
      root,
    );
    assert.equal(result.exitCode, 0);
    assert.match(await readFile(path.join(root, "nouveau.txt"), "utf8"), /test avec espaces/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the entry point runs through an alternate symbolic path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "timeagent-linked-bin-"));
  try {
    await execFileAsync("git", ["init"], { cwd: root });
    const realDist = path.dirname(fileURLToPath(import.meta.url));
    const linkedDist = path.join(root, "linked-dist");
    await symlink(realDist, linkedDist, process.platform === "win32" ? "junction" : "dir");

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [path.join(linkedDist, "cli.js"), "run", process.execPath, "--version"],
      { cwd: root, encoding: "utf8" },
    );

    assert.equal(stderr, "");
    assert.match(stdout, new RegExp(process.version.replaceAll(".", "\\.")));
    assert.match(stdout, /Changes:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
