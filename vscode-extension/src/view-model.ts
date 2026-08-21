import type { SessionState } from "./core-client";

export type ViewState = { protection: boolean; sessionState: SessionState; agent: string; durationMs: number | null; created: number; modified: number; deleted: number; highRisk: number; denied: number; undoAvailable: boolean; diffAvailable: boolean; actionsAvailable: boolean };
export type ViewNode = { label: string; description?: string; tooltip?: string; icon?: string; children?: ViewNode[]; command?: string; enabled?: boolean };

function duration(ms: number | null): string | undefined {
  if (ms === null) return undefined;
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`;
  const minutes = Math.floor(ms / 60_000); const seconds = Math.round((ms % 60_000) / 1000);
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}
function action(label: string, command: string, icon: string, tooltip: string, enabled = true): ViewNode { return { label, command, icon, tooltip, enabled }; }

export function buildViewNodes(state: ViewState): ViewNode[] {
  const protection: ViewNode = { label: "Protection", icon: state.protection ? "shield" : "shield-x", children: [{ label: state.protection ? "Enabled" : "Disabled", icon: state.protection ? "pass-filled" : "circle-slash", tooltip: "Only sessions started through TimeAgent are currently protected." }] };
  const actions = [
    action("Start Protected Session", "timeagent.startSession", "play", "Start Codex, Claude Code, or a custom command through TimeAgent."),
    action("Refresh", "timeagent.refreshStatus", "refresh", "Refresh TimeAgent session information."),
    action(state.protection ? "Disable Protection" : "Enable Protection", state.protection ? "timeagent.disableProtection" : "timeagent.enableProtection", state.protection ? "shield-x" : "shield", "Control whether new sessions are presented as protected in this workspace."),
  ];
  if (state.sessionState === "none" || state.sessionState === "invalid") return [protection, { label: "Session", children: [{ label: state.sessionState === "invalid" ? "Checkpoint unavailable" : "No protected session", icon: "circle-outline" }] }, { label: "Actions", children: actions }];
  const agent = state.agent === "—" ? "Protected session" : state.agent;
  const stateLabel = state.sessionState === "active" ? "Running" : state.sessionState === "completed" ? "Completed" : "Interrupted";
  const elapsed = duration(state.durationMs);
  const sessionChildren: ViewNode[] = [{ label: agent, icon: state.sessionState === "active" ? "sync~spin" : state.sessionState === "interrupted" ? "history" : "check" }, { label: stateLabel, description: elapsed, tooltip: elapsed ? `${stateLabel} · ${elapsed}` : stateLabel }];
  if (state.sessionState === "interrupted") sessionChildren.push({ label: "Recovery checkpoint available", icon: "history", tooltip: "The pre-session checkpoint can be restored." });
  const nodes: ViewNode[] = [protection, { label: "Session", children: sessionChildren }];
  if (state.sessionState === "active") nodes.push({ label: "Changes", children: [{ label: "Available after session completion", icon: "clock" }] });
  else {
    nodes.push({ label: "Changes", children: [{ label: "Created", description: String(state.created), icon: "diff-added" }, { label: "Modified", description: String(state.modified), icon: "diff-modified" }, { label: "Deleted", description: String(state.deleted), icon: "diff-removed" }] });
    if (state.actionsAvailable || state.highRisk > 0 || state.denied > 0) nodes.push({ label: "External Actions", children: [{ label: "High risk", description: String(state.highRisk), icon: "warning", tooltip: "High-risk commands observed during this session." }, { label: "Denied", description: String(state.denied), icon: "circle-slash" }] });
    actions.splice(1, 0, action(state.sessionState === "interrupted" ? "Review Current Changes" : "Review Changes", "timeagent.reviewChanges", "diff", "Open the files changed during this TimeAgent session.", state.diffAvailable), action(state.sessionState === "interrupted" ? "Restore Session" : "Undo Last Session", "timeagent.undoSession", "discard", "Restore the workspace to its exact pre-session TimeAgent checkpoint.", state.undoAvailable));
    if (state.actionsAvailable) actions.splice(3, 0, action("View External Actions", "timeagent.viewExternalActions", "list-tree", "Commands observed by TimeAgent's experimental PATH-based interception layer."));
  }
  nodes.push({ label: "Actions", children: actions }); return nodes;
}
