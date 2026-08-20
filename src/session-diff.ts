import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { diffSnapshots, type FileChanges } from "./diff.js";
import { findGitRoot } from "./git.js";
import { inspectCheckpoint, type AvailableCheckpoint, type SessionMetadata } from "./checkpoint.js";
import { captureSnapshot, type FileFingerprint, type Snapshot } from "./snapshot.js";

const maximumPatchBytes = 1024 * 1024;

export type SessionDiff = {
  root: string;
  state: "completed" | "interrupted";
  session: SessionMetadata;
  completedAt?: string;
  changes: FileChanges;
  after: Snapshot;
  checkpoint: Extract<AvailableCheckpoint, { kind: "completed" | "pending" }>;
};

export async function getSessionDiff(cwd = process.cwd()): Promise<SessionDiff> {
  const root = await findGitRoot(cwd);
  const checkpoint = await inspectCheckpoint(root);
  if (checkpoint.kind === "none") throw new Error("No TimeAgent session is available for diff.");
  if (checkpoint.kind === "invalid") throw new Error(`Invalid checkpoint: ${checkpoint.reason}`);
  if (checkpoint.kind === "pending" && checkpoint.active) {
    throw new Error("Session is still active. The final diff is not available yet.");
  }
  if (checkpoint.kind === "pending") {
    const current = await captureSnapshot(root);
    return {
      root,
      state: "interrupted",
      session: checkpoint.session,
      changes: diffSnapshots(checkpoint.before, current),
      after: current,
      checkpoint,
    };
  }
  return {
    root,
    state: "completed",
    session: checkpoint.manifest.session,
    completedAt: checkpoint.manifest.completedAt,
    changes: diffSnapshots(checkpoint.before, checkpoint.after),
    after: checkpoint.after,
    checkpoint,
  };
}

function commandLabel(session: SessionMetadata): string {
  return [session.command, ...session.args].join(" ");
}

function duration(startedAt: string, completedAt?: string): string | undefined {
  if (!completedAt) return undefined;
  const seconds = Math.max(0, Math.round((Date.parse(completedAt) - Date.parse(startedAt)) / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes ? `${minutes}m${remainder}s` : `${remainder}s`;
}

export function formatDiffSummary(report: SessionDiff): string {
  const lines = [
    `Session: ${commandLabel(report.session)}`,
    `State: ${report.state === "completed" ? "completed" : "interrupted"}`,
    `Started: ${report.session.startedAt}`,
  ];
  const elapsed = duration(report.session.startedAt, report.completedAt);
  if (elapsed) lines.push(`Duration: ${elapsed}`);
  if (report.state === "interrupted") {
    lines.push("", "Warning: this session was not finalized.", "This diff compares the pre-session checkpoint with the repository's current state.");
  }
  const sections: Array<[string, string, string[]]> = [
    ["Created", "+", report.changes.created],
    ["Modified", "~", report.changes.modified],
    ["Deleted", "-", report.changes.deleted],
  ];
  for (const [label, marker, files] of sections) {
    lines.push("", `${label} (${files.length})`);
    for (const file of files) lines.push(`  ${marker} ${file}`);
  }
  const total = sections.reduce((sum, section) => sum + section[2].length, 0);
  lines.push("", `Total: ${total} file${total === 1 ? "" : "s"} changed`);
  return lines.join("\n");
}

type ContentResult = { kind: "text"; text: string } | { kind: "binary" } | { kind: "large" } | { kind: "missing" };

async function loadContent(file: string): Promise<ContentResult> {
  try {
    const metadata = await stat(file);
    if (metadata.size > maximumPatchBytes) return { kind: "large" };
    const handle = await open(file, "r");
    let contents: Buffer;
    try {
      contents = await readFile(handle);
    } finally {
      await handle.close();
    }
    if (contents.includes(0)) return { kind: "binary" };
    try {
      return { kind: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(contents) };
    } catch {
      return { kind: "binary" };
    }
  } catch {
    return { kind: "missing" };
  }
}

function fingerprint(report: SessionDiff, relativePath: string, side: "before" | "after"): FileFingerprint | undefined {
  if (side === "before") return report.checkpoint.before.get(relativePath);
  return report.after.get(relativePath);
}

async function sideContent(report: SessionDiff, relativePath: string, side: "before" | "after"): Promise<ContentResult> {
  const item = fingerprint(report, relativePath, side);
  if (item?.kind === "symlink") return { kind: "binary" };
  if (side === "before") {
    if (!item) return { kind: "text", text: "" };
    return loadContent(path.join(report.checkpoint.directory, "files", ...relativePath.split("/")));
  }
  const afterFingerprint = report.after.get(relativePath);
  if (!afterFingerprint) return { kind: "text", text: "" };
  if (afterFingerprint.kind === "symlink") return { kind: "binary" };
  const source = report.checkpoint.kind === "completed"
    ? path.join(report.checkpoint.directory, "after-files", ...relativePath.split("/"))
    : path.join(report.root, ...relativePath.split("/"));
  return loadContent(source);
}

function patchLines(relativePath: string, before: string, after: string): string {
  if (before === after) return "";
  const beforeLines = before.split(/(?<=\n)/);
  const afterLines = after.split(/(?<=\n)/);
  return [
    `--- before/${relativePath}`,
    `+++ after/${relativePath}`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ...beforeLines.map((line) => `-${line.replace(/\n$/, "")}`),
    ...afterLines.map((line) => `+${line.replace(/\n$/, "")}`),
  ].join("\n");
}

export async function formatPatch(report: SessionDiff): Promise<string> {
  const files = [...report.changes.created, ...report.changes.modified, ...report.changes.deleted].sort();
  const sections: string[] = [];
  for (const file of files) {
    const [before, after] = await Promise.all([sideContent(report, file, "before"), sideContent(report, file, "after")]);
    if (before.kind === "binary" || after.kind === "binary") {
      sections.push(`${file}\nBinary file changed`);
    } else if (before.kind === "large" || after.kind === "large") {
      sections.push(`${file}\nFile too large for patch`);
    } else if (before.kind === "missing" || after.kind === "missing") {
      sections.push(`${file}\nContent unavailable for patch`);
    } else {
      sections.push(patchLines(file, before.text, after.text));
    }
  }
  return sections.filter(Boolean).join("\n\n");
}
