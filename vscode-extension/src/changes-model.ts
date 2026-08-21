import type { ChangeType, TimeAgentDiff } from "./core-client";

export type ChangeNode = {
  kind: "group" | "file";
  label: string;
  changeType?: ChangeType;
  path?: string;
  children?: ChangeNode[];
};

const groupOrder: Array<{ type: ChangeType; label: string }> = [
  { type: "created", label: "Created" },
  { type: "modified", label: "Modified" },
  { type: "deleted", label: "Deleted" },
];

export function groupChangedFiles(diff: TimeAgentDiff | undefined): ChangeNode[] {
  if (!diff) return [];
  return groupOrder.map(({ type, label }) => {
    const files = diff.files.filter((file) => file.changeType === type).sort((left, right) => left.path.localeCompare(right.path));
    return {
      kind: "group" as const,
      label: `${label} (${files.length})`,
      children: files.map((file) => ({ kind: "file" as const, label: file.path.split("/").at(-1) ?? file.path, path: file.path, changeType: type })),
    };
  });
}
