import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildTerminalCommand, canLaunchAgent, detectAgent, detectAgents, detectedAgentSessionArgs, detectTimeAgent, protectedSessionArgs, resolveExecutable, type ExecAdapter } from "./cli";

test("detects an installed TimeAgent CLI even when --help returns a usage exit code", async () => {
  const execute: ExecAdapter = async () => ({ stdout: "", stderr: "Usage: timeagent", exitCode: 2 });
  assert.equal(await detectTimeAgent(execute), true);
});

test("reports a missing TimeAgent CLI", async () => {
  const execute: ExecAdapter = async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); };
  assert.equal(await detectTimeAgent(execute), false);
});

test("constructs Codex and Claude commands", () => {
  assert.deepEqual(protectedSessionArgs("codex"), ["run", "codex"]);
  assert.deepEqual(protectedSessionArgs("claude"), ["run", "claude"]);
  assert.equal(buildTerminalCommand(protectedSessionArgs("codex")), "timeagent run codex");
  assert.equal(buildTerminalCommand(protectedSessionArgs("claude")), "timeagent run claude");
});

test("quotes terminal arguments containing spaces", () => {
  assert.equal(buildTerminalCommand(["run", "C:/Workspace With Spaces/agent.exe"], "win32"), "timeagent run \"C:/Workspace With Spaces/agent.exe\"");
  assert.equal(buildTerminalCommand(["run", "/workspace with spaces/agent"], "linux"), "timeagent run '/workspace with spaces/agent'");
});

test("detects available and missing Codex and Claude executables", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "timeagent-agent-path-"));
  try {
    const extension = process.platform === "win32" ? ".cmd" : "";
    await writeFile(path.join(directory, `codex${extension}`), "");
    const env = { PATH: directory, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
    const agents = await detectAgents(env);
    assert.equal(agents.codex.available, true);
    assert.equal(agents.claude.available, false);
    await writeFile(path.join(directory, `claude${extension}`), "");
    assert.equal((await detectAgent("claude", env)).available, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("resolves Windows npm shims from PATH entries containing spaces", async (context) => {
  if (process.platform !== "win32") { context.skip("Windows executable resolution regression."); return; }
  const root = await mkdtemp(path.join(tmpdir(), "timeagent path with spaces "));
  try {
    const bin = path.join(root, "npm global bin"); await mkdir(bin);
    const shim = path.join(bin, "codex.cmd"); await writeFile(shim, "@echo off\r\n");
    assert.equal(await resolveExecutable("codex", { Path: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD" }), shim);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a missing selected agent is rejected before terminal launch while custom commands remain supported", () => {
  assert.equal(canLaunchAgent({ command: "codex", available: false }), false);
  assert.equal(detectedAgentSessionArgs({ command: "codex", available: false }), undefined);
  assert.deepEqual(detectedAgentSessionArgs({ command: "claude", available: true, executable: "claude.cmd" }), ["run", "claude"]);
  assert.deepEqual(protectedSessionArgs("claude"), ["run", "claude"]);
});
