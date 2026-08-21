import assert from "node:assert/strict";
import test from "node:test";
import { shouldShowWelcome } from "./onboarding";

test("shows onboarding once only when the CLI is available", () => {
  assert.equal(shouldShowWelcome(true, false), true);
  assert.equal(shouldShowWelcome(true, true), false);
  assert.equal(shouldShowWelcome(false, false), false);
});
