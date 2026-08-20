import assert from "node:assert/strict";
import test from "node:test";
import { diffSnapshots } from "./diff.js";
import type { Snapshot } from "./snapshot.js";

const fingerprint = (hash: string) => ({ kind: "file" as const, hash, mode: 0o100644 });

test("classifies created, modified, and deleted files", () => {
  const before: Snapshot = new Map([
    ["modified.txt", fingerprint("old")],
    ["deleted.txt", fingerprint("same")],
    ["untouched.txt", fingerprint("same")],
  ]);
  const after: Snapshot = new Map([
    ["created.txt", fingerprint("new")],
    ["modified.txt", fingerprint("new")],
    ["untouched.txt", fingerprint("same")],
  ]);

  assert.deepEqual(diffSnapshots(before, after), {
    created: ["created.txt"],
    modified: ["modified.txt"],
    deleted: ["deleted.txt"],
  });
});
