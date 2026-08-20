import type { Snapshot } from "./snapshot.js";

export type FileChanges = {
  created: string[];
  modified: string[];
  deleted: string[];
};

export function diffSnapshots(before: Snapshot, after: Snapshot): FileChanges {
  const changes: FileChanges = { created: [], modified: [], deleted: [] };

  for (const [file, current] of after) {
    const previous = before.get(file);
    if (!previous) {
      changes.created.push(file);
    } else if (
      previous.kind !== current.kind ||
      previous.hash !== current.hash ||
      previous.mode !== current.mode
    ) {
      changes.modified.push(file);
    }
  }

  for (const file of before.keys()) {
    if (!after.has(file)) changes.deleted.push(file);
  }

  changes.created.sort();
  changes.modified.sort();
  changes.deleted.sort();
  return changes;
}
