import assert from "node:assert/strict";
import test from "node:test";
import { ProtectionState, type WorkspaceState } from "./protection";

test("persists protection state in workspace storage", async () => {
  const values = new Map<string, unknown>();
  const state: WorkspaceState = {
    get: <T>(key: string, fallback: T) => (values.has(key) ? values.get(key) as T : fallback),
    update: async (key, value) => { values.set(key, value); },
  };
  const first = new ProtectionState(state);
  assert.equal(first.isEnabled(), false);
  await first.setEnabled(true);
  assert.equal(new ProtectionState(state).isEnabled(), true);
});
