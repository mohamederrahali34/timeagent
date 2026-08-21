import assert from "node:assert/strict";
import test from "node:test";
import { selectWorkspace, type WorkspaceCandidate } from "./workspace";

test("returns no workspace when none is open", async () => {
  assert.equal(await selectWorkspace(undefined, async () => undefined), undefined);
  assert.equal(await selectWorkspace([], async () => undefined), undefined);
});

test("uses the only workspace and preserves paths containing spaces", async () => {
  const folder = { name: "Project", path: "C:\\Users\\Example User\\Project" };
  assert.equal(await selectWorkspace([folder], async () => undefined), folder);
});

test("delegates multiple workspace selection instead of choosing silently", async () => {
  const folders: WorkspaceCandidate[] = [{ name: "One", path: "/one" }, { name: "Two", path: "/two" }];
  let offered: readonly WorkspaceCandidate[] = [];
  const selected = await selectWorkspace(folders, async (options) => { offered = options; return options[1]; });
  assert.equal(offered, folders);
  assert.equal(selected, folders[1]);
});
