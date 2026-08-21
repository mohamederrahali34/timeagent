import * as vscode from "vscode";
import type { TimeAgentDiff } from "../core-client";
import { groupChangedFiles, type ChangeNode } from "../changes-model";

export class ChangesView implements vscode.TreeDataProvider<ChangeNode> {
  private readonly changes = new vscode.EventEmitter<ChangeNode | undefined | void>();
  readonly onDidChangeTreeData = this.changes.event;
  private nodes: ChangeNode[] = [];

  update(diff: TimeAgentDiff | undefined): void { this.nodes = groupChangedFiles(diff); this.changes.fire(); }

  getTreeItem(node: ChangeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, node.kind === "group" ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    if (node.kind === "file" && node.path && node.changeType) {
      item.description = node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : undefined;
      item.tooltip = node.path;
      item.iconPath = new vscode.ThemeIcon(node.changeType === "created" ? "diff-added" : node.changeType === "deleted" ? "diff-removed" : "diff-modified");
      item.command = { command: "timeagent.openFileDiff", title: "Open TimeAgent Diff", arguments: [node.path] };
    }
    return item;
  }

  getChildren(node?: ChangeNode): ChangeNode[] { return node?.children ?? (node ? [] : this.nodes); }
}
