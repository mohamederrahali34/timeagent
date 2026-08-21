import assert from "node:assert/strict";
import test from "node:test";
import { DiffContentCache, diffBlockReason, nativeDiffInvocation } from "./diff-content";
import type { TimeAgentDiffFile } from "./core-client";

function file(changeType: TimeAgentDiffFile["changeType"], before: TimeAgentDiffFile["before"], after: TimeAgentDiffFile["after"], binary = false): TimeAgentDiffFile {
  return { schemaVersion: 1, path: "src/app.ts", changeType, sessionState: "completed", warning: null, binary, before, after };
}
const text = (content: string) => ({ exists: true, contentAvailable: true, unavailableReason: null, content } as const);
const absent = { exists: false, contentAvailable: false, unavailableReason: null, content: null } as const;

test("builds opaque native diff documents for a modified file", () => {
  const cache = new DiffContentCache();
  const docs = cache.store(file("modified", text("before"), text("after")));
  assert.equal(cache.content(docs.before.id, "before"), "before");
  assert.equal(cache.content(docs.after.id, "after"), "after");
  assert.equal(docs.title, "TimeAgent: src/app.ts (Before ↔ After)");
  assert.equal(docs.before.id, docs.after.id);
});

test("uses an empty virtual side for created and deleted files", () => {
  const cache = new DiffContentCache();
  const created = cache.store(file("created", absent, text("created")));
  assert.equal(cache.content(created.before.id, "before"), "");
  const deleted = cache.store(file("deleted", text("deleted"), absent));
  assert.equal(cache.content(deleted.after.id, "after"), "");
});

test("does not expose binary or too-large content and invalidates stale documents", () => {
  const cache = new DiffContentCache();
  const unavailable = { exists: true, contentAvailable: false, unavailableReason: "too-large", content: null } as const;
  const large = cache.store(file("modified", unavailable, unavailable));
  assert.equal(diffBlockReason(file("modified", unavailable, unavailable)), "too-large");
  assert.equal(cache.content(large.before.id, "before"), undefined);
  const binary = cache.store(file("modified", { ...unavailable, unavailableReason: "binary" }, { ...unavailable, unavailableReason: "binary" }, true));
  assert.equal(diffBlockReason(file("modified", { ...unavailable, unavailableReason: "binary" }, { ...unavailable, unavailableReason: "binary" }, true)), "binary");
  assert.equal(cache.content(binary.after.id, "after"), undefined);
  cache.invalidate();
  assert.equal(cache.content(large.before.id, "before"), undefined);
});

test("constructs the native VS Code diff command without exposing storage paths", () => {
  assert.deepEqual(nativeDiffInvocation("timeagent-diff://opaque/before", "timeagent-diff://opaque/after", "TimeAgent: app.ts"), {
    command: "vscode.diff", args: ["timeagent-diff://opaque/before", "timeagent-diff://opaque/after", "TimeAgent: app.ts"],
  });
});
