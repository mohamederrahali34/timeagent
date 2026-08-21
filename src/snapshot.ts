import { createHash } from "node:crypto";
import { lstat, opendir, readFile, readlink } from "node:fs/promises";
import path from "node:path";

export type FileFingerprint = {
  kind: "file" | "symlink" | "directory";
  hash: string;
  mode: number;
  linkTarget?: string;
};

export type Snapshot = Map<string, FileFingerprint>;

async function hashFile(filePath: string): Promise<string> {
  const contents = await readFile(filePath);
  return createHash("sha256").update(contents).digest("hex");
}

async function visit(root: string, directory: string, result: Snapshot): Promise<void> {
  const handle = await opendir(directory);

  for await (const entry of handle) {
    const rootEntryName = process.platform === "win32" ? entry.name.toLowerCase() : entry.name;
    if (directory === root && (rootEntryName === ".git" || rootEntryName === ".timeagent")) continue;

    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");

    if (entry.isDirectory()) {
      const metadata = await lstat(absolutePath);
      result.set(relativePath, {
        kind: "directory",
        hash: createHash("sha256").update("").digest("hex"),
        mode: metadata.mode,
      });
      await visit(root, absolutePath, result);
    } else if (entry.isSymbolicLink()) {
      const [target, metadata] = await Promise.all([readlink(absolutePath), lstat(absolutePath)]);
      result.set(relativePath, {
        kind: "symlink",
        hash: createHash("sha256").update(target).digest("hex"),
        mode: metadata.mode,
        linkTarget: target,
      });
    } else if (entry.isFile()) {
      const [hash, metadata] = await Promise.all([hashFile(absolutePath), lstat(absolutePath)]);
      result.set(relativePath, { kind: "file", hash, mode: metadata.mode });
    }
  }
}

export async function captureSnapshot(root: string): Promise<Snapshot> {
  const result: Snapshot = new Map();
  await visit(root, root, result);
  return result;
}
