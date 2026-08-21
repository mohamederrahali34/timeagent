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
      if (current.kind !== "directory") changes.created.push(file);
    } else if (
      previous.kind !== current.kind ||
      previous.hash !== current.hash ||
      previous.mode !== current.mode
    ) {
      if (previous.kind !== "directory" || current.kind !== "directory") changes.modified.push(file);
    }
  }

  for (const [file, previous] of before) {
    if (!after.has(file) && previous.kind !== "directory") changes.deleted.push(file);
  }

  changes.created.sort();
  changes.modified.sort();
  changes.deleted.sort();
  return changes;
}
