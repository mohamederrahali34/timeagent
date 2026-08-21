import { executeTimeAgent, type ExecAdapter } from "./cli";

export type SessionState = "none" | "active" | "completed" | "interrupted" | "invalid";
export type ChangeType = "created" | "modified" | "deleted";
export type ActionRisk = "low" | "medium" | "high" | "critical";
export type ActionStatus = "observed" | "allowed" | "denied" | "completed" | "failed";

export type TimeAgentStatus = {
  schemaVersion: 1;
  repository: ".";
  session: {
    available: boolean;
    state: SessionState;
    agent: string | null;
    command: string | null;
    args: string[];
    startedAt: string | null;
    durationMs: number | null;
    undoAvailable: boolean;
    recoveryCheckpointAvailable: boolean;
    invalidReason: string | null;
  };
  changes: { created: number; modified: number; deleted: number };
  externalActions: { total: number; highRisk: number; critical: number; denied: number };
};

export type TimeAgentDiff = {
  schemaVersion: 1;
  sessionState: "completed" | "interrupted";
  warning: { code: "interrupted-session"; message: string } | null;
  files: Array<{ path: string; changeType: ChangeType; binary: boolean }>;
  summary: { created: number; modified: number; deleted: number; total: number };
};

export type TimeAgentDiffFile = {
  schemaVersion: 1;
  path: string;
  changeType: ChangeType;
  sessionState: "completed" | "interrupted";
  warning: { code: "interrupted-session"; message: string } | null;
  binary: boolean;
  before: DiffFileSide;
  after: DiffFileSide;
};

export type DiffFileSide = {
  exists: boolean;
  contentAvailable: boolean;
  unavailableReason: "binary" | "too-large" | "unavailable" | null;
  content: string | null;
};

export type TimeAgentAction = {
  id: string;
  timestamp: string;
  command: string;
  args: string[];
  cwd: string | null;
  category: string;
  risk: ActionRisk;
  reversible: boolean;
  status: ActionStatus;
  exitCode?: number;
};

export type TimeAgentActionsResponse = {
  schemaVersion: 1;
  actions: TimeAgentAction[];
  summary: { total: number; highRisk: number; critical: number; denied: number };
};

export class CoreClientError extends Error {
  constructor(message: string, readonly kind: "command" | "malformed" | "unsupported") { super(message); }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CoreClientError(`Malformed TimeAgent ${label} response.`, "malformed");
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new CoreClientError(`Missing or invalid ${label}.`, "malformed");
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return string(value, label);
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new CoreClientError(`Missing or invalid ${label}.`, "malformed");
  return value;
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new CoreClientError(`Missing or invalid ${label}.`, "malformed");
  return value;
}

function schema(value: unknown, label: string): Record<string, unknown> {
  const object = record(value, label);
  if (object.schemaVersion !== 1) throw new CoreClientError(`Unsupported TimeAgent ${label} schema version.`, "unsupported");
  return object;
}

function parseJson(output: string, label: string): Record<string, unknown> {
  try { return schema(JSON.parse(output) as unknown, label); }
  catch (error) {
    if (error instanceof CoreClientError) throw error;
    throw new CoreClientError(`TimeAgent returned malformed JSON for ${label}.`, "malformed");
  }
}

function counts(value: unknown, label: string): { created: number; modified: number; deleted: number } {
  const object = record(value, label);
  return { created: number(object.created, `${label}.created`), modified: number(object.modified, `${label}.modified`), deleted: number(object.deleted, `${label}.deleted`) };
}

function actionSummary(value: unknown): TimeAgentStatus["externalActions"] {
  const object = record(value, "externalActions");
  return { total: number(object.total, "externalActions.total"), highRisk: number(object.highRisk, "externalActions.highRisk"), critical: number(object.critical, "externalActions.critical"), denied: number(object.denied, "externalActions.denied") };
}

export function parseStatusJson(output: string): TimeAgentStatus {
  const object = parseJson(output, "status");
  const session = record(object.session, "session");
  const states: SessionState[] = ["none", "active", "completed", "interrupted", "invalid"];
  if (!states.includes(session.state as SessionState)) throw new CoreClientError("Invalid TimeAgent session state.", "malformed");
  if (!Array.isArray(session.args) || !session.args.every((item) => typeof item === "string")) throw new CoreClientError("Invalid TimeAgent session arguments.", "malformed");
  if (object.repository !== ".") throw new CoreClientError("Invalid TimeAgent repository identifier.", "malformed");
  return {
    schemaVersion: 1,
    repository: ".",
    session: {
      available: boolean(session.available, "session.available"),
      state: session.state as SessionState,
      agent: nullableString(session.agent, "session.agent"),
      command: nullableString(session.command, "session.command"),
      args: session.args as string[],
      startedAt: nullableString(session.startedAt, "session.startedAt"),
      durationMs: session.durationMs === null ? null : number(session.durationMs, "session.durationMs"),
      undoAvailable: boolean(session.undoAvailable, "session.undoAvailable"),
      recoveryCheckpointAvailable: boolean(session.recoveryCheckpointAvailable, "session.recoveryCheckpointAvailable"),
      invalidReason: nullableString(session.invalidReason, "session.invalidReason"),
    },
    changes: counts(object.changes, "changes"),
    externalActions: actionSummary(object.externalActions),
  };
}

function safeRelativePath(value: unknown): string {
  const file = string(value, "file.path");
  if (!file || file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file) || file.split(/[\\/]/).includes("..")) {
    throw new CoreClientError("TimeAgent returned an unsafe file path.", "malformed");
  }
  return file.replaceAll("\\", "/");
}

export function parseDiffJson(output: string): TimeAgentDiff {
  const object = parseJson(output, "diff");
  if (object.sessionState !== "completed" && object.sessionState !== "interrupted") throw new CoreClientError("Invalid diff session state.", "malformed");
  if (!Array.isArray(object.files)) throw new CoreClientError("Invalid diff files.", "malformed");
  const files = object.files.map((value) => {
    const file = record(value, "file");
    if (file.changeType !== "created" && file.changeType !== "modified" && file.changeType !== "deleted") throw new CoreClientError("Invalid file change type.", "malformed");
    return { path: safeRelativePath(file.path), changeType: file.changeType as ChangeType, binary: boolean(file.binary, "file.binary") };
  });
  const summaryObject = record(object.summary, "summary");
  const base = counts(summaryObject, "summary");
  const warning = object.warning === null ? null : record(object.warning, "warning");
  return {
    schemaVersion: 1,
    sessionState: object.sessionState,
    warning: warning ? { code: string(warning.code, "warning.code") as "interrupted-session", message: string(warning.message, "warning.message") } : null,
    files,
    summary: { ...base, total: number(summaryObject.total, "summary.total") },
  };
}

function parseDiffFileSide(value: unknown, label: string): DiffFileSide {
  const side = record(value, label);
  const reason = side.unavailableReason;
  if (reason !== null && reason !== "binary" && reason !== "too-large" && reason !== "unavailable") {
    throw new CoreClientError(`Invalid ${label}.unavailableReason.`, "malformed");
  }
  return {
    exists: boolean(side.exists, `${label}.exists`),
    contentAvailable: boolean(side.contentAvailable, `${label}.contentAvailable`),
    unavailableReason: reason,
    content: nullableString(side.content, `${label}.content`),
  };
}

export function parseDiffFileJson(output: string): TimeAgentDiffFile {
  const object = parseJson(output, "diff-file");
  if (object.changeType !== "created" && object.changeType !== "modified" && object.changeType !== "deleted") throw new CoreClientError("Invalid diff-file change type.", "malformed");
  if (object.sessionState !== "completed" && object.sessionState !== "interrupted") throw new CoreClientError("Invalid diff-file session state.", "malformed");
  const warning = object.warning === null ? null : record(object.warning, "warning");
  return {
    schemaVersion: 1,
    path: safeRelativePath(object.path),
    changeType: object.changeType,
    sessionState: object.sessionState,
    warning: warning ? { code: string(warning.code, "warning.code") as "interrupted-session", message: string(warning.message, "warning.message") } : null,
    binary: boolean(object.binary, "binary"),
    before: parseDiffFileSide(object.before, "before"),
    after: parseDiffFileSide(object.after, "after"),
  };
}

export function parseActionsJson(output: string): TimeAgentActionsResponse {
  const object = parseJson(output, "actions");
  if (!Array.isArray(object.actions)) throw new CoreClientError("Invalid actions list.", "malformed");
  const risks: ActionRisk[] = ["low", "medium", "high", "critical"];
  const statuses: ActionStatus[] = ["observed", "allowed", "denied", "completed", "failed"];
  const actions = object.actions.map((value) => {
    const action = record(value, "action");
    if (!Array.isArray(action.args) || !action.args.every((item) => typeof item === "string") || !risks.includes(action.risk as ActionRisk) || !statuses.includes(action.status as ActionStatus)) {
      throw new CoreClientError("Invalid TimeAgent action.", "malformed");
    }
    return {
      id: string(action.id, "action.id"), timestamp: string(action.timestamp, "action.timestamp"), command: string(action.command, "action.command"),
      args: action.args as string[], cwd: action.cwd === null ? null : string(action.cwd, "action.cwd"), category: string(action.category, "action.category"),
      risk: action.risk as ActionRisk, reversible: boolean(action.reversible, "action.reversible"), status: action.status as ActionStatus,
      ...(action.exitCode === undefined ? {} : { exitCode: number(action.exitCode, "action.exitCode") }),
    };
  });
  const summaryObject = record(object.summary, "summary");
  return { schemaVersion: 1, actions, summary: { total: number(summaryObject.total, "summary.total"), highRisk: number(summaryObject.highRisk, "summary.highRisk"), critical: number(summaryObject.critical, "summary.critical"), denied: number(summaryObject.denied, "summary.denied") } };
}

export class TimeAgentCoreClient {
  constructor(private readonly execute?: ExecAdapter) {}

  private async command(args: string[], cwd: string): Promise<string> {
    const result = await executeTimeAgent(args, cwd, this.execute);
    if (result.exitCode !== 0) throw new CoreClientError(result.stderr.trim() || `TimeAgent exited with code ${result.exitCode}.`, "command");
    return result.stdout;
  }

  async version(cwd?: string): Promise<string> {
    const result = await executeTimeAgent(["--version"], cwd ?? process.cwd(), this.execute);
    const version = result.stdout.trim();
    const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (result.exitCode !== 0 || !match || Number(match[1]) === 0 && (Number(match[2]) < 2 || Number(match[2]) === 2 && Number(match[3]) < 1)) {
      throw new CoreClientError("TimeAgent CLI 0.2.1 or newer is required for this extension.", "unsupported");
    }
    return version;
  }

  async status(cwd: string): Promise<TimeAgentStatus> { return parseStatusJson(await this.command(["status", "--json"], cwd)); }
  async diff(cwd: string): Promise<TimeAgentDiff> { return parseDiffJson(await this.command(["diff", "--json"], cwd)); }
  async diffFile(cwd: string, relativePath: string): Promise<TimeAgentDiffFile> { return parseDiffFileJson(await this.command(["diff-file", relativePath, "--json"], cwd)); }
  async actions(cwd: string): Promise<TimeAgentActionsResponse> { return parseActionsJson(await this.command(["actions", "--json"], cwd)); }
  async undo(cwd: string): Promise<void> { await this.command(["undo", "--yes"], cwd); }
}
