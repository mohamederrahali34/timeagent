import assert from "node:assert/strict";
import test from "node:test";
import { completionTrackingMode, sessionCompletionMessage, sessionLaunchFailureMessage } from "./session-lifecycle";
import { validStatus } from "./test-fixtures";

test("reports completed and interrupted extension-launched sessions", () => {
  assert.equal(sessionCompletionMessage(validStatus), "TimeAgent session completed: 6 files changed.");
  assert.equal(sessionCompletionMessage({ ...validStatus, session: { ...validStatus.session, state: "interrupted" } }),
    "TimeAgent session interrupted. Recovery checkpoint available.");
});

test("surfaces a launch failure after executable detection", () => {
  assert.match(sessionLaunchFailureMessage(1) ?? "", /exited with code 1/);
  assert.equal(sessionLaunchFailureMessage(0), undefined);
});

test("uses manual refresh when terminal shell integration is unavailable", () => {
  assert.equal(completionTrackingMode(true), "shell-integration");
  assert.equal(completionTrackingMode(false), "manual-refresh");
});
