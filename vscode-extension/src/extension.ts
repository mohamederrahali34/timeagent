import * as vscode from "vscode";
import { buildTerminalCommand, detectAgents, detectedAgentSessionArgs, detectTimeAgent, parseCustomCommand, type AgentChoice } from "./cli";
import { CoreClientError, TimeAgentCoreClient, type TimeAgentStatus } from "./core-client";
import { DiffContentCache, diffBlockReason, nativeDiffInvocation } from "./diff-content";
import { diffScheme, TimeAgentDiffProvider } from "./diff-provider";
import { ProtectionState } from "./protection";
import { shouldShowWelcome, welcomeStateKey } from "./onboarding";
import { sessionCompletionMessage, sessionLaunchFailureMessage } from "./session-lifecycle";
import { actionLabel, statusViewState } from "./ui-model";
import { performConfirmedUndo } from "./undo-flow";
import { ChangesView } from "./views/changesView";
import { TimeAgentView, type ViewState } from "./views/timeagentView";
import { selectWorkspace, type WorkspaceCandidate } from "./workspace";

const initialViewState: ViewState = {
  protection: false, sessionState: "none", agent: "—", durationMs: null, created: 0, modified: 0, deleted: 0, highRisk: 0, denied: 0,
  undoAvailable: false, diffAvailable: false, actionsAvailable: false,
};

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const protection = new ProtectionState(context.workspaceState);
  const client = new TimeAgentCoreClient();
  const view = new TimeAgentView({ ...initialViewState, protection: protection.isEnabled() });
  const changesView = new ChangesView();
  const diffProvider = new TimeAgentDiffProvider(new DiffContentCache());
  const tree = vscode.window.createTreeView("timeagent.overview", { treeDataProvider: view, showCollapseAll: false });
  const changesTree = vscode.window.createTreeView("timeagent.changes", { treeDataProvider: changesView, showCollapseAll: false });
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  statusBar.command = "workbench.view.extension.timeagent";
  statusBar.tooltip = "Open TimeAgent";
  statusBar.show();
  let cliAvailable = await detectTimeAgent();
  let compatible = cliAvailable;
  let terminal: vscode.Terminal | undefined;
  let startedSession = false;
  let startedAgent: string | undefined;
  let currentStatus: TimeAgentStatus | undefined;
  let activeExecution: vscode.TerminalShellExecution | undefined;
  let awaitingIntegration: { terminal: vscode.Terminal; commandLine: string; root: string } | undefined;
  let integrationTimer: ReturnType<typeof setTimeout> | undefined;

  const updateStatusBar = () => {
    statusBar.text = !cliAvailable ? "$(shield) TimeAgent: CLI missing"
      : !compatible ? "$(shield) TimeAgent: Upgrade required"
        : currentStatus?.session.state === "interrupted" ? "$(warning) TimeAgent: Recovery available"
          : currentStatus?.session.state === "active" || startedSession ? `$(sync~spin) TimeAgent: ${startedAgent ?? currentStatus?.session.agent ?? "Session"} running`
            : currentStatus && currentStatus.changes.created + currentStatus.changes.modified + currentStatus.changes.deleted > 0
              ? `$(diff) TimeAgent: ${currentStatus.changes.created + currentStatus.changes.modified + currentStatus.changes.deleted} changes`
            : protection.isEnabled() ? "$(shield) TimeAgent: Ready" : "$(shield) TimeAgent: Off";
  };
  updateStatusBar();

  async function workspaceRoot(showMessage = true): Promise<string | undefined> {
    const folders: WorkspaceCandidate[] | undefined = vscode.workspace.workspaceFolders?.map((folder) => ({ name: folder.name, path: folder.uri.fsPath }));
    const selected = await selectWorkspace(folders, async (options) => {
      const choice = await vscode.window.showQuickPick(options.map((option) => ({ label: option.name, description: option.path, option })), { placeHolder: "Select the repository for TimeAgent" });
      return choice?.option;
    });
    if (!selected && showMessage) await vscode.window.showWarningMessage(folders?.length ? "No TimeAgent workspace was selected." : "Open a workspace folder before using TimeAgent.");
    return selected?.path;
  }

  async function showMissingCli(): Promise<void> {
    const choice = await vscode.window.showErrorMessage("TimeAgent CLI is not installed.", "Copy Install Command", "Open Documentation");
    if (choice === "Copy Install Command") {
      await vscode.env.clipboard.writeText("npm install -g timeagent");
      void vscode.window.showInformationMessage("Install command copied to the clipboard.");
    } else if (choice === "Open Documentation") await vscode.env.openExternal(vscode.Uri.parse("https://github.com/mohamederrahali34/timeagent#installation-from-source"));
  }

  async function showUpgradeRequired(): Promise<void> {
    const choice = await vscode.window.showErrorMessage("TimeAgent CLI 0.2.1 or newer is required for this extension.", "Copy Upgrade Command", "Open Documentation");
    if (choice === "Copy Upgrade Command") {
      await vscode.env.clipboard.writeText("npm install -g timeagent@latest");
      void vscode.window.showInformationMessage("Upgrade command copied to the clipboard.");
    } else if (choice === "Open Documentation") await vscode.env.openExternal(vscode.Uri.parse("https://github.com/mohamederrahali34/timeagent"));
  }

  async function showMissingAgent(agent: AgentChoice): Promise<void> {
    const name = agent === "codex" ? "Codex" : "Claude Code";
    const choice = await vscode.window.showErrorMessage(`${name} CLI was not found.`, "Open Documentation", "Cancel");
    if (choice === "Open Documentation") {
      const url = agent === "codex" ? "https://developers.openai.com/codex/cli/" : "https://docs.anthropic.com/en/docs/claude-code/getting-started";
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }
  }

  function showCoreError(error: unknown): void {
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }

  async function showClientError(error: unknown): Promise<void> {
    if (error instanceof CoreClientError && (error.kind === "unsupported" || error.kind === "malformed")) await showUpgradeRequired();
    else showCoreError(error);
  }

  async function refreshStatus(rootOverride?: string): Promise<void> {
    const root = rootOverride ?? await workspaceRoot();
    if (!root) return;
    diffProvider.invalidate();
    cliAvailable = await detectTimeAgent();
    if (!cliAvailable) { compatible = false; updateStatusBar(); await showMissingCli(); return; }
    try {
      await client.version(root);
      currentStatus = await client.status(root);
      compatible = true;
      if (currentStatus.session.state !== "active" && !activeExecution && !awaitingIntegration) { startedSession = false; startedAgent = undefined; }
      view.update(statusViewState(currentStatus, protection.isEnabled()));
      if (currentStatus.session.state === "completed" || currentStatus.session.state === "interrupted") changesView.update(await client.diff(root));
      else changesView.update(undefined);
      updateStatusBar();
    } catch (error) {
      compatible = !(error instanceof CoreClientError && (error.kind === "unsupported" || error.kind === "malformed"));
      updateStatusBar();
      if (!compatible) await showUpgradeRequired(); else showCoreError(error);
    }
  }

  context.subscriptions.push(
    tree, changesTree, statusBar, diffProvider,
    vscode.workspace.registerTextDocumentContentProvider(diffScheme, diffProvider),
    vscode.commands.registerCommand("timeagent.enableProtection", async () => {
      const root = await workspaceRoot();
      if (!root) return;
      await protection.setEnabled(true);
      view.update({ protection: true });
      void vscode.window.showInformationMessage("TimeAgent protection is enabled for this workspace. Protected sessions must currently be started through TimeAgent.");
      await refreshStatus(root);
    }),
    vscode.commands.registerCommand("timeagent.disableProtection", async () => {
      await protection.setEnabled(false);
      view.update({ protection: false });
      const root = await workspaceRoot(false);
      if (root) await refreshStatus(root); else updateStatusBar();
    }),
    vscode.commands.registerCommand("timeagent.refreshStatus", () => refreshStatus()),
    vscode.commands.registerCommand("timeagent.startSession", async () => {
      const root = await workspaceRoot();
      if (!root) return;
      try { await client.version(root); await client.status(root); }
      catch (error) {
        if (error instanceof CoreClientError && (error.kind === "unsupported" || error.kind === "malformed")) await showUpgradeRequired();
        else showCoreError(error);
        return;
      }
      const availability = await detectAgents();
      const selected = await vscode.window.showQuickPick([
        { label: "Codex", description: availability.codex.available ? "Installed" : "Not found", agent: "codex" as AgentChoice },
        { label: "Claude Code", description: availability.claude.available ? "Installed" : "Not found", agent: "claude" as AgentChoice },
        { label: "Custom command", description: "Run another executable through TimeAgent", agent: undefined },
      ], { placeHolder: "Choose a coding agent" });
      if (!selected) return;
      let args: string[];
      let agent: string;
      if (selected.agent) {
        const detected = availability[selected.agent];
        const detectedArgs = detectedAgentSessionArgs(detected);
        if (!detectedArgs) { await showMissingAgent(selected.agent); return; }
        args = detectedArgs;
        agent = selected.agent === "codex" ? "Codex" : "Claude Code";
      }
      else {
        const custom = await vscode.window.showInputBox({ prompt: "Command to run through TimeAgent", placeHolder: "aider --model example" });
        if (custom === undefined) return;
        try { args = ["run", ...parseCustomCommand(custom)]; } catch (error) { showCoreError(error); return; }
        agent = args[1];
      }
      if (!terminal || terminal.exitStatus) terminal = vscode.window.createTerminal({ name: "TimeAgent", cwd: root });
      terminal.show();
      const commandLine = buildTerminalCommand(args);
      diffProvider.invalidate();
      changesView.update(undefined);
      startedSession = true;
      startedAgent = agent;
      view.update({ sessionState: "active", agent, durationMs: null });
      updateStatusBar();
      if (terminal.shellIntegration) activeExecution = terminal.shellIntegration.executeCommand(commandLine);
      else {
        awaitingIntegration = { terminal, commandLine, root };
        integrationTimer = setTimeout(() => {
          if (!awaitingIntegration) return;
          awaitingIntegration.terminal.sendText(awaitingIntegration.commandLine, true);
          awaitingIntegration = undefined;
          integrationTimer = undefined;
          void vscode.window.showInformationMessage("TimeAgent started without terminal completion tracking. Use Refresh Status after the command exits.");
        }, 3000);
      }
    }),
    vscode.commands.registerCommand("timeagent.undoSession", async () => {
      const root = await workspaceRoot();
      if (!root) return;
      try {
        const structuredStatus = await client.status(root);
        const result = await performConfirmedUndo(structuredStatus, async (message) =>
          await vscode.window.showWarningMessage(message, { modal: true }, "Restore") === "Restore", () => client.undo(root));
        if (result === "unavailable") void vscode.window.showInformationMessage("No TimeAgent session is currently available to undo.");
        else if (result === "restored") {
          diffProvider.invalidate();
          changesView.update(undefined);
          void vscode.window.showInformationMessage("TimeAgent restored the pre-session workspace state.");
          await refreshStatus(root);
        }
      } catch (error) { await showClientError(error); }
    }),
    vscode.commands.registerCommand("timeagent.viewExternalActions", async () => {
      const root = await workspaceRoot();
      if (!root) return;
      try {
        const response = await client.actions(root);
        if (response.actions.length === 0) { void vscode.window.showInformationMessage("No external actions were recorded for this session."); return; }
        await vscode.window.showQuickPick(response.actions.map((action) => ({ ...actionLabel(action), action })), { placeHolder: "External actions recorded by TimeAgent" });
      } catch (error) { await showClientError(error); }
    }),
    vscode.commands.registerCommand("timeagent.reviewChanges", async () => {
      const root = await workspaceRoot();
      if (!root) return;
      try {
        const diff = await client.diff(root);
        changesView.update(diff);
        if (diff.warning) void vscode.window.showWarningMessage(diff.warning.message);
        if (diff.files.length === 0) { void vscode.window.showInformationMessage("No files changed during this session."); return; }
        await vscode.commands.executeCommand("timeagent.changes.focus");
      } catch (error) { await showClientError(error); }
    }),
    vscode.commands.registerCommand("timeagent.openFileDiff", async (relativePath: string) => {
      const root = await workspaceRoot();
      if (!root) return;
      try {
        const file = await client.diffFile(root, relativePath);
        const blocked = diffBlockReason(file);
        if (blocked === "binary") { void vscode.window.showInformationMessage("Binary file changed; text diff is not available."); return; }
        if (blocked) {
          void vscode.window.showInformationMessage(blocked === "too-large"
            ? "This file is too large for the TimeAgent text diff (1 MiB limit)."
            : "Text diff content is unavailable for this file.");
          return;
        }
        const documents = diffProvider.cache.store(file);
        const invocation = nativeDiffInvocation(diffProvider.uri(documents.before), diffProvider.uri(documents.after), documents.title);
        await vscode.commands.executeCommand(invocation.command, ...invocation.args);
      } catch (error) { await showClientError(error); }
    }),
    vscode.window.onDidChangeTerminalShellIntegration((event) => {
      if (!awaitingIntegration || event.terminal !== awaitingIntegration.terminal) return;
      if (integrationTimer) clearTimeout(integrationTimer);
      activeExecution = event.shellIntegration.executeCommand(awaitingIntegration.commandLine);
      awaitingIntegration = undefined;
      integrationTimer = undefined;
    }),
    vscode.window.onDidEndTerminalShellExecution(async (event) => {
      if (event.execution !== activeExecution) return;
      activeExecution = undefined;
      startedSession = false;
      startedAgent = undefined;
      const root = await workspaceRoot(false);
      if (!root) { updateStatusBar(); return; }
      await refreshStatus(root);
      const failure = sessionLaunchFailureMessage(event.exitCode);
      if (failure) void vscode.window.showErrorMessage(failure);
      else if (currentStatus) {
        const message = sessionCompletionMessage(currentStatus);
        if (message) void vscode.window.showInformationMessage(message);
      }
    }),
    vscode.window.onDidCloseTerminal((closed) => {
      if (closed === terminal) {
        if (integrationTimer) clearTimeout(integrationTimer);
        terminal = undefined; activeExecution = undefined; awaitingIntegration = undefined; integrationTimer = undefined;
        startedSession = false; startedAgent = undefined; updateStatusBar();
      }
    }),
  );

  if (!cliAvailable) await showMissingCli();
  else {
    const root = await workspaceRoot(false);
    if (root) await refreshStatus(root);
    if (shouldShowWelcome(true, context.globalState.get<boolean>(welcomeStateKey, false))) {
      await context.globalState.update(welcomeStateKey, true);
      const choice = await vscode.window.showInformationMessage(
        "TimeAgent is ready. Start a protected Codex or Claude Code session from the TimeAgent sidebar.", "Open TimeAgent", "Dismiss");
      if (choice === "Open TimeAgent") await vscode.commands.executeCommand("workbench.view.extension.timeagent");
    }
  }
}

export function deactivate(): void {}
