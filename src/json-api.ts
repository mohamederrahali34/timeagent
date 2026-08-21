import path from "node:path";
import { realpath } from "node:fs/promises";
import { getActions, type ExternalAction } from "./actions.js";
import { findGitRoot } from "./git.js";
import { getDiffFileSides, getSessionDiff, inspectDiffFile, type ContentResult, type SessionDiff } from "./session-diff.js";
import { getStatus, type TimeAgentStatus } from "./status.js";

export const jsonSchemaVersion = 1 as const;

type SessionState = "none" | "active" | "completed" | "interrupted" | "invalid";

export type StatusJson = {
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

function agentName(command: string): string {
  const name = path.basename(command).replace(/\.(cmd|exe)$/i, "").toLowerCase();
  return name === "claude" ? "claude" : name === "codex" ? "codex" : command;
}

function statusJson(status: TimeAgentStatus): StatusJson {
  const emptyChanges = { created: 0, modified: 0, deleted: 0 };
  const emptyActions = { total: 0, highRisk: 0, critical: 0, denied: 0 };
  if (status.kind === "none" || status.kind === "invalid") {
    return {
      schemaVersion: 1,
      repository: ".",
      session: {
        available: false,
        state: status.kind,
        agent: null,
        command: null,
        args: [],
        startedAt: null,
        durationMs: null,
        undoAvailable: false,
        recoveryCheckpointAvailable: false,
        invalidReason: status.kind === "invalid" ? status.reason : null,
      },
      changes: emptyChanges,
      externalActions: emptyActions,
    };
  }
  const changes = "changes" in status
    ? { created: status.changes.created.length, modified: status.changes.modified.length, deleted: status.changes.deleted.length }
    : emptyChanges;
  const completedAt = status.kind === "completed" ? status.completedAt : undefined;
  return {
    schemaVersion: 1,
    repository: ".",
    session: {
      available: true,
      state: status.kind,
      agent: agentName(status.session.command),
      command: status.session.command,
      args: redactArguments(status.session.args),
      startedAt: status.session.startedAt,
      durationMs: completedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(status.session.startedAt)) : null,
      undoAvailable: status.kind === "completed" || status.kind === "interrupted",
      recoveryCheckpointAvailable: status.kind === "interrupted",
      invalidReason: null,
    },
    changes,
    externalActions: status.actions,
  };
}

export async function getStatusJson(cwd = process.cwd()): Promise<StatusJson> {
  return statusJson(await getStatus(cwd));
}

export type DiffJson = {
  schemaVersion: 1;
  sessionState: "completed" | "interrupted";
  warning: { code: "interrupted-session"; message: string } | null;
  files: Array<{ path: string; changeType: "created" | "modified" | "deleted"; binary: boolean }>;
  summary: { created: number; modified: number; deleted: number; total: number };
};

export async function sessionDiffJson(report: SessionDiff): Promise<DiffJson> {
  const entries = [
    ...report.changes.created.map((file) => ({ path: file, changeType: "created" as const })),
    ...report.changes.modified.map((file) => ({ path: file, changeType: "modified" as const })),
    ...report.changes.deleted.map((file) => ({ path: file, changeType: "deleted" as const })),
  ].sort((left, right) => left.path.localeCompare(right.path));
  const files = await Promise.all(entries.map(async (entry) => ({ ...entry, binary: (await inspectDiffFile(report, entry.path)).binary })));
  return {
    schemaVersion: 1,
    sessionState: report.state,
    warning: report.state === "interrupted"
      ? { code: "interrupted-session", message: "This session was not finalized; the diff uses the repository's current state." }
      : null,
    files,
    summary: {
      created: report.changes.created.length,
      modified: report.changes.modified.length,
      deleted: report.changes.deleted.length,
      total: files.length,
    },
  };
}

export async function getDiffJson(cwd = process.cwd()): Promise<DiffJson> {
  return sessionDiffJson(await getSessionDiff(cwd));
}

export type DiffFileJson = {
  schemaVersion: 1;
  path: string;
  changeType: "created" | "modified" | "deleted";
  sessionState: "completed" | "interrupted";
  warning: { code: "interrupted-session"; message: string } | null;
  binary: boolean;
  before: { exists: boolean; contentAvailable: boolean; unavailableReason: "binary" | "too-large" | "unavailable" | null; content: string | null };
  after: { exists: boolean; contentAvailable: boolean; unavailableReason: "binary" | "too-large" | "unavailable" | null; content: string | null };
};

function validateDiffPath(root: string, value: string): string {
  if (!value || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || value.includes("\\")) throw new Error(`Invalid repository-relative path: ${value}`);
  const segments = value.split("/");
  const first = process.platform === "win32" ? segments[0].toLowerCase() : segments[0];
  if (segments.some((segment) => !segment || segment === "." || segment === "..") || first === ".git" || first === ".timeagent") {
    throw new Error(`Invalid repository-relative path: ${value}`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, ...segments);
  const normalize = (item: string) => process.platform === "win32" ? item.toLowerCase() : item;
  if (!normalize(resolved).startsWith(`${normalize(resolvedRoot)}${path.sep}`)) throw new Error(`Path escapes the repository: ${value}`);
  return segments.join("/");
}

function inside(root: string, candidate: string): boolean {
  const normalize = (item: string) => process.platform === "win32" ? path.resolve(item).toLowerCase() : path.resolve(item);
  const canonicalRoot = normalize(root);
  const canonicalCandidate = normalize(candidate);
  return canonicalCandidate === canonicalRoot || canonicalCandidate.startsWith(`${canonicalRoot}${path.sep}`);
}

async function validateDiffFileContainment(report: SessionDiff, relativePath: string): Promise<void> {
  const canonicalRoot = await realpath(report.root);
  const projectPath = path.join(report.root, ...relativePath.split("/"));
  for (const fingerprint of [report.checkpoint.before.get(relativePath), report.after.get(relativePath)]) {
    if (fingerprint?.kind === "symlink" && fingerprint.linkTarget) {
      const target = path.resolve(path.dirname(projectPath), fingerprint.linkTarget);
      if (!inside(canonicalRoot, target)) throw new Error(`Symlink target escapes the repository: ${relativePath}`);
    }
  }
  if (report.state === "interrupted" && report.after.get(relativePath)?.kind === "file") {
    try {
      const canonicalFile = await realpath(projectPath);
      if (!inside(canonicalRoot, canonicalFile)) throw new Error(`Path escapes the repository through a link: ${relativePath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function contentSide(result: ContentResult, exists: boolean, binary: boolean): DiffFileJson["before"] {
  if (!exists) return { exists: false, contentAvailable: true, unavailableReason: null, content: null };
  if (binary || result.kind === "binary") return { exists: true, contentAvailable: false, unavailableReason: "binary", content: null };
  if (result.kind === "large") return { exists: true, contentAvailable: false, unavailableReason: "too-large", content: null };
  if (result.kind === "missing") return { exists: true, contentAvailable: false, unavailableReason: "unavailable", content: null };
  return { exists: true, contentAvailable: true, unavailableReason: null, content: result.text };
}

export async function getDiffFileJson(relativePath: string, cwd = process.cwd()): Promise<DiffFileJson> {
  const root = await findGitRoot(cwd);
  const safePath = validateDiffPath(await realpath(root), relativePath);
  const report = await getSessionDiff(root);
  const created = report.changes.created.includes(safePath);
  const modified = report.changes.modified.includes(safePath);
  const deleted = report.changes.deleted.includes(safePath);
  if (!created && !modified && !deleted) throw new Error(`File is not part of the current session diff: ${safePath}`);
  await validateDiffFileContainment(report, safePath);
  const sides = await getDiffFileSides(report, safePath);
  const binary = sides.before.kind === "binary" || sides.after.kind === "binary";
  return {
    schemaVersion: 1,
    path: safePath,
    changeType: created ? "created" : modified ? "modified" : "deleted",
    sessionState: report.state,
    warning: report.state === "interrupted"
      ? { code: "interrupted-session", message: "This session was not finalized; after content uses the repository's current state." }
      : null,
    binary,
    before: contentSide(sides.before, sides.beforeExists, binary),
    after: contentSide(sides.after, sides.afterExists, binary),
  };
}

const secretFlags = /^(--?(?:api[-_]?key|token|password|passwd|secret|client[-_]?secret|access[-_]?token))$/i;
const secretAssignment = /^(--?(?:api[-_]?key|token|password|passwd|secret|client[-_]?secret|access[-_]?token))=(.*)$/i;

export function redactArguments(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const assignment = args[index].match(secretAssignment);
    if (assignment) result.push(`${assignment[1]}=[REDACTED]`);
    else if (secretFlags.test(args[index])) {
      result.push(args[index]);
      if (index + 1 < args.length) { result.push("[REDACTED]"); index++; }
    } else result.push(args[index]);
  }
  return result;
}

async function relativeCwd(root: string, cwd: string): Promise<string | null> {
  let canonicalRoot: string;
  let canonicalCwd: string;
  try {
    [canonicalRoot, canonicalCwd] = await Promise.all([realpath(root), realpath(cwd)]);
  } catch {
    return null;
  }
  const relative = path.relative(canonicalRoot, canonicalCwd);
  if (!relative) return ".";
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

export type ActionsJson = {
  schemaVersion: 1;
  actions: Array<Omit<ExternalAction, "sessionId" | "cwd" | "args"> & { args: string[]; cwd: string | null }>;
  summary: { total: number; highRisk: number; critical: number; denied: number };
};

export async function getActionsJson(cwd = process.cwd()): Promise<ActionsJson> {
  const root = await findGitRoot(cwd);
  const actions = await getActions(root);
  const publicActions = await Promise.all(actions.map(async ({ sessionId: _sessionId, cwd: actionCwd, args, ...action }) => ({
    ...action,
    args: redactArguments(args),
    cwd: await relativeCwd(root, actionCwd),
  })));
  return {
    schemaVersion: 1,
    actions: publicActions,
    summary: {
      total: actions.length,
      highRisk: actions.filter((action) => action.risk === "high" || action.risk === "critical").length,
      critical: actions.filter((action) => action.risk === "critical").length,
      denied: actions.filter((action) => action.status === "denied").length,
    },
  };
}
