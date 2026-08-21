import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");

test("run ENOENT is concise, non-zero, and has no successful session summary", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "timeagent-missing-command-"));
  try {
    await execFileAsync("git", ["init"], { cwd: root });
    await assert.rejects(execFileAsync(process.execPath, [cliPath, "run", "timeagent-command-that-does-not-exist"], { cwd: root, encoding: "utf8" }),
      (error: unknown) => {
        const result = error as { code?: number; stdout?: string; stderr?: string };
        assert.notEqual(result.code, 0);
        assert.match(result.stderr ?? "", /timeagent: failed to start "timeagent-command-that-does-not-exist": command not found/);
        assert.doesNotMatch(result.stderr ?? "", /spawn .* ENOENT/);
        assert.doesNotMatch(result.stdout ?? "", /Changes:|No files changed/);
        return true;
      });
    await assert.rejects(access(path.join(root, ".timeagent", "pending")), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
