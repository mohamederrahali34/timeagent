import { diffSnapshots, type FileChanges } from "./diff.js";
import { findGitRoot } from "./git.js";
import { inspectCheckpoint, type SessionMetadata } from "./checkpoint.js";
import { captureSnapshot } from "./snapshot.js";

export type TimeAgentStatus =
  | { kind: "none" }
  | { kind: "invalid"; reason: string }
  | { kind: "active"; session: SessionMetadata }
  | { kind: "interrupted"; session: SessionMetadata; changes: FileChanges }
  | { kind: "completed"; session: SessionMetadata; changes: FileChanges };

export async function getStatus(cwd = process.cwd()): Promise<TimeAgentStatus> {
  const root = await findGitRoot(cwd);
  const checkpoint = await inspectCheckpoint(root);
  if (checkpoint.kind === "none") return { kind: "none" };
  if (checkpoint.kind === "invalid") return { kind: "invalid", reason: checkpoint.reason };
  if (checkpoint.kind === "pending") {
    if (checkpoint.active) return { kind: "active", session: checkpoint.session };
    const current = await captureSnapshot(root);
    return { kind: "interrupted", session: checkpoint.session, changes: diffSnapshots(checkpoint.before, current) };
  }
  return { kind: "completed", session: checkpoint.manifest.session, changes: diffSnapshots(checkpoint.before, checkpoint.after) };
}

function commandLabel(session: SessionMetadata): string {
  return [session.command, ...session.args].join(" ");
}

function changeLines(changes: FileChanges): string[] {
  return [`  Created: ${changes.created.length}`, `  Modified: ${changes.modified.length}`, `  Deleted: ${changes.deleted.length}`];
}

export function formatStatus(status: TimeAgentStatus): string {
  if (status.kind === "none") return "No restorable TimeAgent session.";
  if (status.kind === "invalid") return `Invalid recovery checkpoint detected.\nReason: ${status.reason}\nUndo available: no`;
  if (status.kind === "active") {
    return [`Last session: ${commandLabel(status.session)}`, "State: active", `Started: ${status.session.startedAt}`, "Undo available: no"].join("\n");
  }
  if (status.kind === "interrupted") {
    return [
      `Last session: ${commandLabel(status.session)}`,
      "State: interrupted",
      `Started: ${status.session.startedAt}`,
      "Recovery checkpoint: available",
      "Undo available: yes",
      "",
      "Current changes since the checkpoint:",
      ...changeLines(status.changes),
    ].join("\n");
  }
  return [
    `Last session: ${commandLabel(status.session)}`,
    "State: completed",
    `Started: ${status.session.startedAt}`,
    `Files created: ${status.changes.created.length}`,
    `Files modified: ${status.changes.modified.length}`,
    `Files deleted: ${status.changes.deleted.length}`,
    "Undo available: yes",
  ].join("\n");
}
