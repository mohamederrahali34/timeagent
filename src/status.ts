import { diffSnapshots, type FileChanges } from "./diff.js";
import { findGitRoot } from "./git.js";
import { inspectCheckpoint, type SessionMetadata } from "./checkpoint.js";
import { captureSnapshot } from "./snapshot.js";
import { readActionsFromCheckpoint } from "./actions.js";

type ActionSummary = { total: number; highRisk: number; denied: number };

export type TimeAgentStatus =
  | { kind: "none" }
  | { kind: "invalid"; reason: string }
  | { kind: "active"; session: SessionMetadata; actions: ActionSummary }
  | { kind: "interrupted"; session: SessionMetadata; changes: FileChanges; actions: ActionSummary }
  | { kind: "completed"; session: SessionMetadata; changes: FileChanges; actions: ActionSummary };

function summarizeActions(actions: Awaited<ReturnType<typeof readActionsFromCheckpoint>>): ActionSummary {
  return {
    total: actions.length,
    highRisk: actions.filter((action) => action.risk === "high" || action.risk === "critical").length,
    denied: actions.filter((action) => action.status === "denied").length,
  };
}

export async function getStatus(cwd = process.cwd()): Promise<TimeAgentStatus> {
  const root = await findGitRoot(cwd);
  const checkpoint = await inspectCheckpoint(root);
  if (checkpoint.kind === "none") return { kind: "none" };
  if (checkpoint.kind === "invalid") return { kind: "invalid", reason: checkpoint.reason };
  if (checkpoint.kind === "pending") {
    const actions = summarizeActions(await readActionsFromCheckpoint(checkpoint.directory, checkpoint.session.sessionId));
    if (checkpoint.active) return { kind: "active", session: checkpoint.session, actions };
    const current = await captureSnapshot(root);
    return { kind: "interrupted", session: checkpoint.session, changes: diffSnapshots(checkpoint.before, current), actions };
  }
  const actions = summarizeActions(await readActionsFromCheckpoint(checkpoint.directory, checkpoint.manifest.session.sessionId));
  return { kind: "completed", session: checkpoint.manifest.session, changes: diffSnapshots(checkpoint.before, checkpoint.after), actions };
}

function commandLabel(session: SessionMetadata): string {
  return [session.command, ...session.args].join(" ");
}

function changeLines(changes: FileChanges): string[] {
  return [`  Created: ${changes.created.length}`, `  Modified: ${changes.modified.length}`, `  Deleted: ${changes.deleted.length}`];
}

function actionLines(actions: ActionSummary): string[] {
  return [`External actions: ${actions.total} observed`, `High-risk actions: ${actions.highRisk}`, `Denied actions: ${actions.denied}`];
}

export function formatStatus(status: TimeAgentStatus): string {
  if (status.kind === "none") return "No restorable TimeAgent session.";
  if (status.kind === "invalid") return `Invalid recovery checkpoint detected.\nReason: ${status.reason}\nUndo available: no`;
  if (status.kind === "active") {
    return [`Last session: ${commandLabel(status.session)}`, "State: active", `Started: ${status.session.startedAt}`, ...actionLines(status.actions), "Undo available: no"].join("\n");
  }
  if (status.kind === "interrupted") {
    return [
      `Last session: ${commandLabel(status.session)}`,
      "State: interrupted",
      `Started: ${status.session.startedAt}`,
      "Recovery checkpoint: available",
      ...actionLines(status.actions),
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
    ...actionLines(status.actions),
    "Undo available: yes",
  ].join("\n");
}
