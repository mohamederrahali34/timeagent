import * as vscode from "vscode";
import { DiffContentCache, type DiffDocumentDescriptor, type DiffSide } from "./diff-content";

export const diffScheme = "timeagent-diff";

export class TimeAgentDiffProvider implements vscode.TextDocumentContentProvider {
  private readonly changes = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changes.event;
  private readonly knownUris = new Set<string>();

  constructor(readonly cache: DiffContentCache) {}

  uri(descriptor: DiffDocumentDescriptor): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: diffScheme, authority: descriptor.id, path: `/${descriptor.side}`, query: `title=${encodeURIComponent(descriptor.title)}` });
    this.knownUris.add(uri.toString());
    return uri;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const side = uri.path.slice(1) as DiffSide;
    return this.cache.content(uri.authority, side) ?? "TimeAgent diff content is no longer available. Refresh the session before reopening this diff.";
  }

  invalidate(): void {
    this.cache.invalidate();
    for (const value of this.knownUris) this.changes.fire(vscode.Uri.parse(value));
    this.knownUris.clear();
  }

  dispose(): void { this.changes.dispose(); }
}
