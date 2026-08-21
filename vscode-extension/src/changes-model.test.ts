import assert from "node:assert/strict";
import test from "node:test";
import { groupChangedFiles } from "./changes-model";

test("groups and sorts changed files deterministically", () => {
  const nodes = groupChangedFiles({ schemaVersion: 1, sessionState: "completed", warning: null,
    files: [
      { path: "z.ts", changeType: "modified", binary: false },
      { path: "src/b.ts", changeType: "created", binary: false },
      { path: "src/a.ts", changeType: "created", binary: false },
      { path: "old.ts", changeType: "deleted", binary: false },
    ], summary: { created: 2, modified: 1, deleted: 1, total: 4 } });
  assert.deepEqual(nodes.map((node) => node.label), ["Created (2)", "Modified (1)", "Deleted (1)"]);
  assert.deepEqual(nodes[0].children?.map((node) => node.path), ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(groupChangedFiles(undefined), []);
});
