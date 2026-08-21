# TimeAgent for VS Code

<p align="center">
  <img src="./resources/timeagent-logo.png" width="180" alt="TimeAgent logo">
</p>

Protect, inspect, and undo coding-agent sessions directly from VS Code.

> TimeAgent is experimental. It is not a sandbox. Only sessions launched through TimeAgent are currently protected.

## Quick Start

1. Install TimeAgent Core:

   ```sh
   npm install -g timeagent
   ```

2. Open TimeAgent from the VS Code Activity Bar.
3. Select **Start Protected Session**.
4. Choose Codex, Claude Code, or a custom command.
5. When the session ends, use **Review Changes**, **Undo Last Session**, or **View External Actions**.

## Features

- **Review Changes** opens a native, read-only before/after diff for created, modified, and deleted text files.
- **Undo Last Session** restores the exact pre-session TimeAgent checkpoint after explicit confirmation.
- **External Actions** shows commands observed by TimeAgent's experimental PATH-based interception layer.
- **Recovery** exposes current changes and restoration when an interrupted checkpoint is available.

Binary files and text files larger than 1 MiB are identified without attempting to display their contents.

## Requirements

- VS Code 1.95 or newer
- TimeAgent CLI 0.2.1 or newer available on `PATH`
- An open Git repository

The extension never installs the CLI automatically. If the CLI is missing, it offers to copy the installation command or open the documentation.

## Protection scope

The Protection setting is workspace UI state. A session is protected only when it is launched with **TimeAgent: Start Protected Session**. The extension does not monitor or automatically protect unrelated terminals or coding-agent processes.

For extension-launched sessions, VS Code terminal Shell Integration is used to detect completion and refresh the sidebar. If Shell Integration is unavailable, the extension sends the command once and asks the user to run **TimeAgent: Refresh** after it exits. It does not poll continuously.

Before/after contents are held only in memory behind opaque virtual-document URIs. Refreshing, starting another session, or completing Undo invalidates that cache.

## Local development

```sh
cd vscode-extension
npm install
npm run build
npm test
```

Open `vscode-extension/` as the VS Code workspace and press `F5` to launch an Extension Development Host.

This extension is not affiliated with OpenAI, Anthropic, Microsoft, or VS Code.
