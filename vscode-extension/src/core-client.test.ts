import assert from "node:assert/strict";
import test from "node:test";
import { CoreClientError, parseActionsJson, parseDiffFileJson, parseDiffJson, parseStatusJson, TimeAgentCoreClient } from "./core-client";
import type { ExecAdapter } from "./cli";
import { validStatus } from "./test-fixtures";

test("parses valid status JSON into typed state", () => {
  assert.deepEqual(parseStatusJson(JSON.stringify(validStatus)), validStatus);
});

test("validates diff-file responses and sends paths with spaces as one argument", async () => {
  const response = { schemaVersion: 1, path: "src/my file.ts", changeType: "modified", sessionState: "completed", warning: null, binary: false,
    before: { exists: true, contentAvailable: true, unavailableReason: null, content: "before" },
    after: { exists: true, contentAvailable: true, unavailableReason: null, content: "after" } };
  let invocation: { args: readonly string[]; cwd?: string } | undefined;
  const execute: ExecAdapter = async (_file, args, cwd) => { invocation = { args, cwd }; return { stdout: JSON.stringify(response), stderr: "", exitCode: 0 }; };
  assert.deepEqual(await new TimeAgentCoreClient(execute).diffFile("C:\\Workspace With Spaces", "src/my file.ts"), response);
  assert.deepEqual(invocation, { args: ["diff-file", "src/my file.ts", "--json"], cwd: "C:\\Workspace With Spaces" });
  assert.throws(() => parseDiffFileJson(JSON.stringify({ ...response, path: "../secret" })), /unsafe file path/);
  assert.throws(() => parseDiffFileJson(JSON.stringify({ ...response, before: { ...response.before, unavailableReason: "mystery" } })), /unavailableReason/);
});

test("rejects malformed JSON and missing required fields", () => {
  assert.throws(() => parseStatusJson("{broken"), (error: unknown) => error instanceof CoreClientError && error.kind === "malformed");
  assert.throws(() => parseStatusJson(JSON.stringify({ schemaVersion: 1 })), /session/i);
});

test("rejects unsupported schema versions", () => {
  assert.throws(() => parseStatusJson(JSON.stringify({ ...validStatus, schemaVersion: 2 })),
    (error: unknown) => error instanceof CoreClientError && error.kind === "unsupported");
});

test("detects an old CLI without version support", async () => {
  const execute: ExecAdapter = async () => ({ stdout: "", stderr: "Usage: timeagent", exitCode: 2 });
  await assert.rejects(new TimeAgentCoreClient(execute).version("C:\\Workspace With Spaces"),
    (error: unknown) => error instanceof CoreClientError && error.kind === "unsupported");
});

test("detects missing JSON capability even when a CLI returns human prose", () => {
  assert.throws(() => parseStatusJson("No restorable TimeAgent session."),
    (error: unknown) => error instanceof CoreClientError && error.kind === "malformed");
});

test("surfaces Core command failures", async () => {
  const execute: ExecAdapter = async () => ({ stdout: "", stderr: "timeagent: invalid checkpoint", exitCode: 1 });
  await assert.rejects(new TimeAgentCoreClient(execute).status("C:\\Workspace With Spaces"), /invalid checkpoint/);
});

test("the typed undo client passes explicit confirmation to Core and preserves a spaced cwd", async () => {
  let invocation: { args: readonly string[]; cwd?: string } | undefined;
  const execute: ExecAdapter = async (_file, args, cwd) => { invocation = { args, cwd }; return { stdout: "ok", stderr: "", exitCode: 0 }; };
  await new TimeAgentCoreClient(execute).undo("C:\\Workspace With Spaces");
  assert.deepEqual(invocation, { args: ["undo", "--yes"], cwd: "C:\\Workspace With Spaces" });
});

test("parses actions and changed files", () => {
  const actions = parseActionsJson(JSON.stringify({ schemaVersion: 1, actions: [{
    id: "1", timestamp: "2026-01-01T00:00:00.000Z", command: "vercel", args: ["deploy"], cwd: ".", category: "deployment",
    risk: "high", reversible: false, status: "denied",
  }], summary: { total: 1, highRisk: 1, critical: 0, denied: 1 } }));
  assert.equal(actions.actions[0].status, "denied");

  const diff = parseDiffJson(JSON.stringify({ schemaVersion: 1, sessionState: "completed", warning: null,
    files: [{ path: "src/app.ts", changeType: "modified", binary: false }], summary: { created: 0, modified: 1, deleted: 0, total: 1 } }));
  assert.equal(diff.files[0].path, "src/app.ts");
  assert.throws(() => parseDiffJson(JSON.stringify({ ...diff, files: [{ path: "../secret", changeType: "modified", binary: false }] })), /unsafe file path/);
});
