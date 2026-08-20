import { diffSnapshots, type FileChanges } from "./diff.js";
import { findGitRoot } from "./git.js";
import { inspectCheckpoint, restoreCheckpoint, type SessionMetadata } from "./checkpoint.js";
import { captureSnapshot } from "./snapshot.js";

export type UndoConfirmation = {
  interrupted: boolean;
  session: SessionMetadata;
  changes: FileChanges;
};

export type ConfirmUndo = (changes: FileChanges, context: UndoConfirmation) => Promise<boolean>;

export async function undoLast(cwd = process.cwd(), confirm?: ConfirmUndo, assumeYes = false): Promise<void> {
  const root = await findGitRoot(cwd);
  const checkpoint = await inspectCheckpoint(root);
  if (checkpoint.kind === "none") throw new Error("No restorable TimeAgent checkpoint exists for this repository.");
  if (checkpoint.kind === "invalid") {
    throw new Error(`Invalid recovery checkpoint: ${checkpoint.reason}`);
  }
  if (checkpoint.kind === "pending" && checkpoint.active) {
    throw new Error(`Session ${checkpoint.session.sessionId} appears to still be active (PID ${checkpoint.session.ownerPid}).`);
  }

  const current = await captureSnapshot(root);
  const reference = checkpoint.kind === "completed" ? checkpoint.after : checkpoint.before;
  const changes = diffSnapshots(reference, current);
  const hasChanges = changes.created.length + changes.modified.length + changes.deleted.length > 0;
  const session = checkpoint.kind === "completed" ? checkpoint.manifest.session : checkpoint.session;
  if ((checkpoint.kind === "pending" || hasChanges) && !assumeYes) {
    const context: UndoConfirmation = { interrupted: checkpoint.kind === "pending", session, changes };
    if (!confirm || !(await confirm(changes, context))) {
      throw new Error(
        checkpoint.kind === "pending"
          ? "Recovery cancelled. The interrupted checkpoint was kept."
          : "Undo cancelled. Files changed after the session completed.",
      );
    }
  }
  await restoreCheckpoint(root, checkpoint);
}
