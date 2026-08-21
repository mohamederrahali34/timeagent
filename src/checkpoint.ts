import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import type { FileFingerprint, Snapshot } from "./snapshot.js";
import { readActionsFromCheckpoint } from "./actions.js";

export type SerializedSnapshot = Array<[string, FileFingerprint]>;

export type SessionMetadata = {
  version: 2 | 3;
  sessionId: string;
  repositoryRoot: string;
  command: string;
  args: string[];
  startedAt: string;
  ownerPid: number;
};

export type CheckpointManifest = {
  version: 2 | 3;
  session: SessionMetadata;
  before: SerializedSnapshot;
  after: SerializedSnapshot;
  completedAt?: string;
};

export type AvailableCheckpoint =
  | { kind: "completed"; directory: string; manifest: CheckpointManifest; before: Snapshot; after: Snapshot }
  | { kind: "pending"; directory: string; session: SessionMetadata; before: Snapshot; active: boolean }
  | { kind: "invalid"; location: "last" | "pending"; reason: string }
  | { kind: "none" };

const metadataDirectory = (root: string) => path.join(root, ".timeagent");
const pendingDirectory = (root: string) => path.join(metadataDirectory(root), "pending");
const lastDirectory = (root: string) => path.join(metadataDirectory(root), "last");

async function pathExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function safeProjectPath(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, ...relativePath.split("/"));
  const firstSegment = relativePath.split("/")[0];
  const reservedSegment = process.platform === "win32" ? firstSegment.toLowerCase() : firstSegment;
  if (
    !relativePath ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    reservedSegment === ".git" ||
    reservedSegment === ".timeagent" ||
    resolved === resolvedRoot ||
    !resolved.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new Error(`Invalid path in checkpoint: ${relativePath}`);
  }
  return resolved;
}

function checkpointFile(directory: string, relativePath: string): string {
  return path.join(directory, "files", ...relativePath.split("/"));
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(JSON.stringify(value), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}

function sameRepository(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function parseSession(value: unknown): SessionMetadata {
  const session = value as Partial<SessionMetadata>;
  if (
    !session ||
    (session.version !== 2 && session.version !== 3) ||
    typeof session.sessionId !== "string" ||
    !session.sessionId ||
    typeof session.repositoryRoot !== "string" ||
    typeof session.command !== "string" ||
    !Array.isArray(session.args) ||
    !session.args.every((argument) => typeof argument === "string") ||
    typeof session.startedAt !== "string" ||
    !Number.isFinite(Date.parse(session.startedAt)) ||
    typeof session.ownerPid !== "number" ||
    !Number.isInteger(session.ownerPid) ||
    session.ownerPid <= 0
  ) {
    throw new Error("Invalid session metadata.");
  }
  return session as SessionMetadata;
}

function parseSnapshot(root: string, value: unknown): Snapshot {
  if (!Array.isArray(value)) throw new Error("Unreadable snapshot.");
  const snapshot: Snapshot = new Map();
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string") {
      throw new Error("Invalid snapshot entry.");
    }
    const [relativePath, rawFingerprint] = item as [string, Partial<FileFingerprint>];
    safeProjectPath(root, relativePath);
    if (
      snapshot.has(relativePath) ||
      !rawFingerprint ||
      (rawFingerprint.kind !== "file" && rawFingerprint.kind !== "symlink" && rawFingerprint.kind !== "directory") ||
      typeof rawFingerprint.hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(rawFingerprint.hash) ||
      !Number.isInteger(rawFingerprint.mode) ||
      (rawFingerprint.kind === "symlink" && typeof rawFingerprint.linkTarget !== "string")
    ) {
      throw new Error(`Invalid fingerprint for ${relativePath}.`);
    }
    snapshot.set(relativePath, rawFingerprint as FileFingerprint);
  }
  for (const relativePath of snapshot.keys()) {
    const segments = relativePath.split("/");
    for (let index = 1; index < segments.length; index++) {
      const ancestor = segments.slice(0, index).join("/");
      const ancestorFingerprint = snapshot.get(ancestor);
      if (ancestorFingerprint && ancestorFingerprint.kind !== "directory") {
        throw new Error(`Conflicting checkpoint paths: ${ancestor} and ${relativePath}.`);
      }
    }
  }
  return snapshot;
}

async function validateBackups(directory: string, before: Snapshot): Promise<void> {
  for (const [relativePath, fingerprint] of before) {
    if (fingerprint.kind !== "file") continue;
    let contents: Buffer;
    try {
      contents = await readFile(checkpointFile(directory, relativePath));
    } catch {
      throw new Error(`Missing or unreadable backup: ${relativePath}.`);
    }
    const hash = createHash("sha256").update(contents).digest("hex");
    if (hash !== fingerprint.hash) throw new Error(`Corrupted backup: ${relativePath}.`);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function prepareCheckpoint(root: string, before: Snapshot, command: string, args: string[]): Promise<SessionMetadata> {
  const pending = pendingDirectory(root);
  if (await pathExists(pending)) {
    throw new Error(
      "A pending checkpoint already exists. Run `timeagent status` and `timeagent undo`, or inspect .timeagent/pending before starting another session.",
    );
  }
  await mkdir(path.join(pending, "files"), { recursive: true });

  for (const [relativePath, fingerprint] of before) {
    if (fingerprint.kind !== "file") continue;
    const destination = checkpointFile(pending, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(safeProjectPath(root, relativePath), destination);
  }

  const session: SessionMetadata = {
    version: 3,
    sessionId: randomUUID(),
    repositoryRoot: await realpath(root),
    command,
    args: [...args],
    startedAt: new Date().toISOString(),
    ownerPid: process.pid,
  };
  await writeJsonAtomic(path.join(pending, "before.json"), [...before]);
  await writeJsonAtomic(path.join(pending, "session.json"), session);
  return session;
}

export async function finalizeCheckpoint(root: string, after: Snapshot): Promise<void> {
  const pending = pendingDirectory(root);
  const before = parseSnapshot(root, JSON.parse(await readFile(path.join(pending, "before.json"), "utf8")));
  const session = parseSession(JSON.parse(await readFile(path.join(pending, "session.json"), "utf8")));
  for (const [relativePath, fingerprint] of after) {
    const previous = before.get(relativePath);
    if (
      fingerprint.kind !== "file" ||
      (previous && previous.kind === fingerprint.kind && previous.hash === fingerprint.hash && previous.mode === fingerprint.mode)
    ) continue;
    const destination = path.join(pending, "after-files", ...relativePath.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(safeProjectPath(root, relativePath), destination);
  }
  const manifest: CheckpointManifest = {
    version: session.version,
    session,
    before: [...before],
    after: [...after],
    completedAt: new Date().toISOString(),
  };
  const actions = await readActionsFromCheckpoint(pending, session.sessionId);
  await writeJsonAtomic(path.join(pending, "actions.json"), actions);
  await writeJsonAtomic(path.join(pending, "manifest.json"), manifest);
  await rm(lastDirectory(root), { recursive: true, force: true });
  await rename(pending, lastDirectory(root));
}

async function inspectCompleted(root: string): Promise<AvailableCheckpoint> {
  const directory = lastDirectory(root);
  try {
    const raw = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")) as Partial<CheckpointManifest>;
    if (raw.version !== 2 && raw.version !== 3) throw new Error("Unsupported manifest version.");
    const session = parseSession(raw.session);
    const canonicalRoot = await realpath(root);
    if (!sameRepository(session.repositoryRoot, canonicalRoot)) {
      throw new Error(`Checkpoint belongs to a different repository: ${session.repositoryRoot}`);
    }
    const before = parseSnapshot(root, raw.before);
    const after = parseSnapshot(root, raw.after);
    if (raw.completedAt !== undefined && (typeof raw.completedAt !== "string" || !Number.isFinite(Date.parse(raw.completedAt)))) {
      throw new Error("Invalid session completion date.");
    }
    await validateBackups(directory, before);
    return { kind: "completed", directory, manifest: raw as CheckpointManifest, before, after };
  } catch (error) {
    return { kind: "invalid", location: "last", reason: error instanceof Error ? error.message : String(error) };
  }
}

async function inspectPending(root: string): Promise<AvailableCheckpoint> {
  const directory = pendingDirectory(root);
  try {
    const session = parseSession(JSON.parse(await readFile(path.join(directory, "session.json"), "utf8")));
    const canonicalRoot = await realpath(root);
    if (!sameRepository(session.repositoryRoot, canonicalRoot)) {
      throw new Error(`Checkpoint belongs to a different repository: ${session.repositoryRoot}`);
    }
    const before = parseSnapshot(root, JSON.parse(await readFile(path.join(directory, "before.json"), "utf8")));
    await validateBackups(directory, before);
    return { kind: "pending", directory, session, before, active: isProcessAlive(session.ownerPid) };
  } catch (error) {
    return { kind: "invalid", location: "pending", reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function inspectCheckpoint(root: string): Promise<AvailableCheckpoint> {
  if (await pathExists(lastDirectory(root))) return inspectCompleted(root);
  if (await pathExists(pendingDirectory(root))) return inspectPending(root);
  return { kind: "none" };
}

function sameFingerprint(left: FileFingerprint | undefined, right: FileFingerprint): boolean {
  return Boolean(left && left.kind === right.kind && left.hash === right.hash && left.mode === right.mode);
}

function isInside(candidate: string, directory: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const normalizedCandidate = normalize(candidate);
  const normalizedDirectory = normalize(directory);
  return normalizedCandidate === normalizedDirectory || normalizedCandidate.startsWith(`${normalizedDirectory}${path.sep}`);
}

export async function restoreCheckpoint(
  root: string,
  checkpoint: Extract<AvailableCheckpoint, { kind: "completed" | "pending" }>,
  current: Snapshot,
  cwd: string,
): Promise<void> {
  await validateBackups(checkpoint.directory, checkpoint.before);

  const session = checkpoint.kind === "completed" ? checkpoint.manifest.session : checkpoint.session;
  const directoriesToRemove = session.version >= 3
    ? [...current]
      .filter(([relativePath, fingerprint]) => fingerprint.kind === "directory" && checkpoint.before.get(relativePath)?.kind !== "directory")
      .map(([relativePath]) => relativePath)
      .sort((left, right) => right.split("/").length - left.split("/").length || right.localeCompare(left))
    : [];

  const canonicalCwd = await realpath(cwd);
  let blockedDirectory: string | undefined;
  for (const relativePath of directoriesToRemove) {
    const canonicalDirectory = await realpath(safeProjectPath(root, relativePath));
    if (isInside(canonicalCwd, canonicalDirectory)) {
      blockedDirectory = relativePath;
      break;
    }
  }
  if (blockedDirectory) {
    throw new Error(
      `Cannot undo while your current working directory is inside a directory that must be removed: ${blockedDirectory}\n\n` +
      `Change to the repository root and run:\n\n  cd "${root}"\n  timeagent undo`,
    );
  }

  const nonDirectoriesToRemove = [...current]
    .filter(([relativePath, fingerprint]) => {
      if (fingerprint.kind === "directory") return false;
      const previous = checkpoint.before.get(relativePath);
      return !previous || previous.kind !== fingerprint.kind || (fingerprint.kind === "symlink" && !sameFingerprint(previous, fingerprint));
    })
    .map(([relativePath]) => relativePath)
    .sort((left, right) => right.split("/").length - left.split("/").length || right.localeCompare(left));

  for (const relativePath of nonDirectoriesToRemove) {
    await rm(safeProjectPath(root, relativePath), { force: true });
  }
  for (const relativePath of directoriesToRemove) {
    await rmdir(safeProjectPath(root, relativePath));
  }

  const restoreEntries = [...checkpoint.before].sort((left, right) => left[0].split("/").length - right[0].split("/").length || left[0].localeCompare(right[0]));
  for (const [relativePath, fingerprint] of restoreEntries) {
    const destination = safeProjectPath(root, relativePath);
    if (fingerprint.kind === "directory") {
      await mkdir(destination, { recursive: true });
      await chmod(destination, fingerprint.mode);
    } else if (fingerprint.kind === "file") {
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(checkpointFile(checkpoint.directory, relativePath), destination);
      await chmod(destination, fingerprint.mode);
    } else if (!sameFingerprint(current.get(relativePath), fingerprint)) {
      await mkdir(path.dirname(destination), { recursive: true });
      await symlink(fingerprint.linkTarget!, destination);
    }
  }
  await rm(checkpoint.directory, { recursive: true, force: true });
}
