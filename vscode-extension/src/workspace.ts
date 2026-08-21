export type WorkspaceCandidate = { name: string; path: string };

export async function selectWorkspace(
  folders: readonly WorkspaceCandidate[] | undefined,
  pick: (folders: readonly WorkspaceCandidate[]) => Promise<WorkspaceCandidate | undefined>,
): Promise<WorkspaceCandidate | undefined> {
  if (!folders || folders.length === 0) return undefined;
  if (folders.length === 1) return folders[0];
  return pick(folders);
}
