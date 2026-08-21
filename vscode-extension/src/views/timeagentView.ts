import * as vscode from "vscode";
import { buildViewNodes, type ViewNode, type ViewState } from "../view-model";
export type { ViewState } from "../view-model";

export class TimeAgentView implements vscode.TreeDataProvider<ViewNode> {
  private readonly changes = new vscode.EventEmitter<ViewNode | undefined | void>();
  readonly onDidChangeTreeData = this.changes.event;
  constructor(private state: ViewState) {}
  update(state: Partial<ViewState>): void { this.state = { ...this.state, ...state }; this.changes.fire(); }
  getTreeItem(node: ViewNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, node.children ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    item.description = node.description; item.tooltip = node.tooltip;
    if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon);
    if (node.command && node.enabled !== false) item.command = { command: node.command, title: node.label };
    if (node.enabled === false) { item.description = "Unavailable"; item.contextValue = "disabled"; }
    return item;
  }
  getChildren(node?: ViewNode): ViewNode[] { return node?.children ?? (node ? [] : buildViewNodes(this.state)); }
}
