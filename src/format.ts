import type { FileChanges } from "./diff.js";

export function formatSummary(changes: FileChanges): string {
  const lines = ["", "Changes:"];
  const sections: Array<[string, string[]]> = [
    ["Created", changes.created],
    ["Modified", changes.modified],
    ["Deleted", changes.deleted],
  ];

  if (sections.every(([, files]) => files.length === 0)) {
    lines.push("  No files changed.");
  } else {
    for (const [label, files] of sections) {
      lines.push(`  ${label} (${files.length})`);
      for (const file of files) lines.push(`    - ${file}`);
    }
  }

  return lines.join("\n");
}
