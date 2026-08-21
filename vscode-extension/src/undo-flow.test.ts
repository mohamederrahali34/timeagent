import assert from "node:assert/strict";
import test from "node:test";
import { validStatus } from "./test-fixtures";
import { performConfirmedUndo } from "./undo-flow";

test("undo runs only after explicit confirmation", async () => {
  let prompt = "";
  let calls = 0;
  const result = await performConfirmedUndo(validStatus, async (message) => { prompt = message; return true; }, async () => { calls++; });
  assert.equal(result, "restored");
  assert.equal(calls, 1);
  assert.match(prompt, /Restore the workspace/);
});

test("undo cancellation never calls Core", async () => {
  let calls = 0;
  const result = await performConfirmedUndo(validStatus, async () => false, async () => { calls++; });
  assert.equal(result, "cancelled");
  assert.equal(calls, 0);
});

test("undo is unavailable when Core says it is unavailable", async () => {
  const status = { ...validStatus, session: { ...validStatus.session, undoAvailable: false } };
  assert.equal(await performConfirmedUndo(status, async () => true, async () => {}), "unavailable");
});
