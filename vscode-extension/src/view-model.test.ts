import assert from "node:assert/strict";
import test from "node:test";
import { buildViewNodes, type ViewState } from "./view-model";

const base: ViewState = { protection: true, sessionState: "none", agent: "—", durationMs: null, created: 0, modified: 0, deleted: 0, highRisk: 0, denied: 0, undoAvailable: false, diffAvailable: false, actionsAvailable: false };

test("empty state omits meaningless counters and keeps primary actions accessible", () => {
  const nodes = buildViewNodes(base);
  assert.deepEqual(nodes.map((node) => node.label), ["Protection", "Session", "Actions"]);
  assert.equal(nodes[1].children?.[0].label, "No protected session");
  assert.equal(nodes[2].children?.[0].command, "timeagent.startSession");
  assert.match(nodes[0].children?.[0].tooltip ?? "", /started through TimeAgent/i);
});

test("completed, running, and interrupted states expose meaningful text", () => {
  const completed = buildViewNodes({ ...base, sessionState: "completed", agent: "codex", durationMs: 46_000, created: 1, modified: 3, undoAvailable: true, diffAvailable: true });
  assert.equal(completed.find((node) => node.label === "Session")?.children?.[1].description, "46s");
  assert.deepEqual(completed.find((node) => node.label === "Changes")?.children?.map((node) => node.description), ["1", "3", "0"]);
  const running = buildViewNodes({ ...base, sessionState: "active", agent: "codex" });
  assert.equal(running.find((node) => node.label === "Changes")?.children?.[0].label, "Available after session completion");
  const interrupted = buildViewNodes({ ...base, sessionState: "interrupted", agent: "codex", undoAvailable: true, diffAvailable: true });
  assert.ok(interrupted.find((node) => node.label === "Session")?.children?.some((node) => /Recovery checkpoint/.test(node.label)));
  assert.ok(interrupted.find((node) => node.label === "Actions")?.children?.some((node) => node.label === "Restore Session"));
});
