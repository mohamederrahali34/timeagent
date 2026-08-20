# TimeAgent

Undo coding-agent changes without losing the work you had before the agent started.

## Experimental software

TimeAgent is an experimental v0.1.0 release. Try it first on disposable or test repositories, keep normal backups and version control, and review `timeagent diff` before relying on an undo. TimeAgent is not a replacement for Git.

## The problem

Git can restore committed code, but developers often start an AI coding session with uncommitted work, untracked files, or ignored local files. TimeAgent captures the repository's filesystem state immediately before the child command starts and can restore that state afterward.

## Example

```sh
timeagent run codex
timeagent diff
timeagent undo
```

TimeAgent can also wrap other compatible command-line coding agents:

```sh
timeagent run claude
```

TimeAgent runs an arbitrary child command. These examples do not imply an official integration or partnership with OpenAI, Anthropic, Codex, or Claude.

## Installation from source

TimeAgent is not documented as an npm registry package in this release. Clone the public GitHub repository:

```sh
git clone https://github.com/mohamederrahali34/timeagent.git
cd timeagent
npm install
npm run build
npm link
```

Node.js 20 or newer and Git are required.

## Commands

```text
timeagent run <command> [args...]
timeagent status
timeagent diff
timeagent diff --patch
timeagent undo
timeagent undo --yes
```

- `run` captures a pre-session checkpoint, runs the child command with inherited terminal input/output, and records created, modified, and deleted files.
- `status` reports whether the latest checkpoint is active, completed, interrupted, invalid, or absent.
- `diff` compares the pre-session state with the recorded post-session state. For interrupted sessions, it compares with the current repository state and displays a warning.
- `diff --patch` also displays a simple textual patch. Binary files and files larger than 1 MiB are not rendered as text.
- `undo` restores the pre-session filesystem state. It asks before overwriting changes made after a session or recovering an interrupted session.
- `undo --yes` explicitly confirms that restoration for non-interactive or scripted use.

Arguments are passed directly to the child process without rebuilding a shell command string. Invoke a shell explicitly when shell syntax is required:

```sh
timeagent run sh -c "npm test && npm run build"
```

PowerShell example:

```powershell
timeagent run powershell -NoProfile -Command "'test' | Out-File result.txt"
```

## Crash recovery

If the TimeAgent process or terminal is interrupted before finalization, a recovery checkpoint may remain in `.timeagent/pending/`.

```sh
timeagent status
timeagent undo
```

TimeAgent validates the checkpoint metadata, canonical repository root, paths, and saved file hashes before offering recovery. Interrupted-session recovery always requires explicit confirmation. If input is not interactive, restoration is refused unless `timeagent undo --yes` is used.

## What TimeAgent currently protects

TimeAgent checkpoints local files inside the repository, excluding `.git/` and `.timeagent/`. The current implementation covers:

- files created, modified, or deleted during the session;
- Git-tracked files;
- untracked files;
- ignored files;
- pre-existing user modifications present before `timeagent run`.

Only the latest session is retained in v0.1.0.

## What TimeAgent does not protect

TimeAgent does not roll back effects outside the repository filesystem, including:

- remote databases;
- external APIs;
- cloud infrastructure;
- deployments;
- emails or messages sent by an agent;
- other external side effects;
- secrets changed outside the repository;
- arbitrary operating-system state outside the repository.

TimeAgent v0.1.0 also does not preserve empty directories or every advanced filesystem attribute such as ACLs, ownership, and timestamps. It primarily restores file contents, file presence, basic modes, and symbolic-link targets.

An interrupted restoration can also leave a partially restored working tree if the operating system fails during file replacement. The checkpoint is retained unless restoration completes successfully.

## How it differs from Git

Git versions repository history. TimeAgent captures the immediate pre-agent filesystem state, including user work that may not be committed, tracked, or normally included in Git history. The tools are complementary.

## Development

```sh
npm install
npm run build
npm test
```

The test suite includes real child processes, separate CLI invocations, crash-recovery scenarios, PowerShell argument handling on Windows, and conditional platform-specific signal tests. This release has been exercised on Windows; platform-specific tests are skipped when the host cannot support them. A public CI matrix has not yet been configured.
