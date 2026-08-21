import type { TimeAgentStatus } from "./core-client";

export type UndoResult = "unavailable" | "cancelled" | "restored";

export async function performConfirmedUndo(
  status: TimeAgentStatus,
  confirm: (message: string) => Promise<boolean>,
  undo: () => Promise<void>,
): Promise<UndoResult> {
  if (!status.session.undoAvailable) return "unavailable";
  const message = status.session.state === "interrupted"
    ? "An interrupted TimeAgent session was detected. Restore the workspace to the pre-session checkpoint?"
    : "Restore the workspace to its state before the last TimeAgent session?";
  if (!await confirm(message)) return "cancelled";
  await undo();
  return "restored";
}
