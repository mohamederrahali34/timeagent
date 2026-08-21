import type { TimeAgentStatus } from "./core-client";

export type CompletionTrackingMode = "shell-integration" | "manual-refresh";

export function completionTrackingMode(shellIntegrationAvailable: boolean): CompletionTrackingMode {
  return shellIntegrationAvailable ? "shell-integration" : "manual-refresh";
}

export function sessionCompletionMessage(status: TimeAgentStatus): string | undefined {
  if (status.session.state === "interrupted") return "TimeAgent session interrupted. Recovery checkpoint available.";
  if (status.session.state !== "completed") return undefined;
  const total = status.changes.created + status.changes.modified + status.changes.deleted;
  return `TimeAgent session completed: ${total} file${total === 1 ? "" : "s"} changed.`;
}

export function sessionLaunchFailureMessage(exitCode: number | undefined): string | undefined {
  return exitCode !== undefined && exitCode !== 0 ? `TimeAgent session exited with code ${exitCode}. Check the terminal for details.` : undefined;
}
