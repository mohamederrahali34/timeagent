import assert from "node:assert/strict";
import test from "node:test";
import { validStatus } from "./test-fixtures";
import { actionLabel, changedFileLabel, statusViewState } from "./ui-model";

test("maps structured Core status to real sidebar state and undo availability", () => {
  assert.deepEqual(statusViewState(validStatus, true), {
    protection: true, sessionState: "completed", agent: "Codex", durationMs: 1000, created: 1, modified: 2, deleted: 3, highRisk: 1, denied: 1,
    undoAvailable: true, diffAvailable: true, actionsAvailable: true,
  });
});

test("maps no-session state without enabling review or undo", () => {
  const state = statusViewState({ ...validStatus, session: { ...validStatus.session, available: false, state: "none", undoAvailable: false },
    changes: { created: 0, modified: 0, deleted: 0 }, externalActions: { total: 0, highRisk: 0, critical: 0, denied: 0 } }, false);
  assert.equal(state.sessionState, "none");
  assert.equal(state.undoAvailable, false);
  assert.equal(state.diffAvailable, false);
  assert.equal(state.actionsAvailable, false);
});

test("renders action and changed-file models conservatively", () => {
  assert.deepEqual(actionLabel({ id: "1", timestamp: "2026-01-01T00:00:00.000Z", command: "npm", args: ["install", "x"], cwd: ".",
    category: "package-manager", risk: "medium", reversible: false, status: "completed" }), {
    label: "$(info) npm  MEDIUM  completed", description: new Date("2026-01-01T00:00:00.000Z").toLocaleString(), detail: "package-manager · npm install x",
  });
  assert.deepEqual(changedFileLabel({ path: "src/app.ts", changeType: "modified", binary: false }), { label: "src/app.ts", description: "modified" });
});
