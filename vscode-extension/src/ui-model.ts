import type { TimeAgentAction, TimeAgentDiff, TimeAgentStatus } from "./core-client";
import type { ViewState } from "./views/timeagentView";

export function statusViewState(status: TimeAgentStatus, protection: boolean): ViewState {
  const agent = status.session.agent === "codex" ? "Codex" : status.session.agent === "claude" ? "Claude Code" : status.session.agent;
  return {
    protection,
    sessionState: status.session.state,
    agent: agent ?? "—",
    durationMs: status.session.durationMs,
    created: status.changes.created,
    modified: status.changes.modified,
    deleted: status.changes.deleted,
    highRisk: status.externalActions.highRisk,
    denied: status.externalActions.denied,
    undoAvailable: status.session.undoAvailable,
    diffAvailable: status.session.state === "completed" || status.session.state === "interrupted",
    actionsAvailable: status.externalActions.total > 0,
  };
}

export function actionLabel(action: TimeAgentAction): { label: string; description: string; detail: string } {
  const icon = action.risk === "critical" || action.risk === "high" ? "$(warning)" : action.risk === "medium" ? "$(info)" : "$(check)";
  return {
    label: `${icon} ${action.command}  ${action.risk.toUpperCase()}  ${action.status}`,
    description: new Date(action.timestamp).toLocaleString(),
    detail: `${action.category} · ${[action.command, ...action.args].join(" ")}`,
  };
}

export function changedFileLabel(file: TimeAgentDiff["files"][number]): { label: string; description: string } {
  return { label: file.path, description: `${file.changeType}${file.binary ? " · binary" : ""}` };
}
