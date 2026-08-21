import type { TimeAgentStatus } from "./core-client";

export const validStatus: TimeAgentStatus = {
  schemaVersion: 1,
  repository: ".",
  session: {
    available: true, state: "completed", agent: "codex", command: "codex", args: [], startedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 1000, undoAvailable: true, recoveryCheckpointAvailable: false, invalidReason: null,
  },
  changes: { created: 1, modified: 2, deleted: 3 },
  externalActions: { total: 2, highRisk: 1, critical: 0, denied: 1 },
};
