import type { TimeAgentDiffFile } from "./core-client";

export type DiffSide = "before" | "after";
export type DiffDocumentDescriptor = { id: string; side: DiffSide; title: string };
export type DiffBlockReason = "binary" | "too-large" | "unavailable" | null;

export function diffBlockReason(file: TimeAgentDiffFile): DiffBlockReason {
  if (file.binary) return "binary";
  const side = [file.before, file.after].find((value) => value.exists && !value.contentAvailable);
  return side?.unavailableReason === "too-large" ? "too-large" : side ? "unavailable" : null;
}

export function nativeDiffInvocation<T>(before: T, after: T, title: string): { command: "vscode.diff"; args: [T, T, string] } {
  return { command: "vscode.diff", args: [before, after, title] };
}

export class DiffContentCache {
  private generation = 0;
  private counter = 0;
  private readonly entries = new Map<string, TimeAgentDiffFile>();

  store(file: TimeAgentDiffFile): { before: DiffDocumentDescriptor; after: DiffDocumentDescriptor; title: string } {
    const id = `${this.generation}-${++this.counter}`;
    this.entries.set(id, file);
    const title = `TimeAgent: ${file.path} (Before ↔ After)`;
    return { before: { id, side: "before", title }, after: { id, side: "after", title }, title };
  }

  content(id: string, side: DiffSide): string | undefined {
    const file = this.entries.get(id);
    if (!file) return undefined;
    const value = file[side];
    if (!value.exists) return "";
    return value.contentAvailable ? value.content ?? "" : undefined;
  }

  invalidate(): void {
    this.entries.clear();
    this.generation++;
  }
}
