import { spawn } from "node:child_process";
import { diffSnapshots, type FileChanges } from "./diff.js";
import { findGitRoot } from "./git.js";
import { captureSnapshot } from "./snapshot.js";
import { finalizeCheckpoint, prepareCheckpoint } from "./checkpoint.js";

export type RunResult = FileChanges & {
  exitCode: number;
  signal: NodeJS.Signals | null;
  gitRoot: string;
};

const trackedSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

function exitCodeForSignal(signal: NodeJS.Signals): number {
  return signal === "SIGINT" ? 130 : 143;
}

export function executeCommand(command: string, args: readonly string[], cwd: string): Promise<{ exitCode: number; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      shell: false,
      stdio: ["inherit", "inherit", "inherit"],
      windowsVerbatimArguments: false,
    });
    let forwardedSignal: NodeJS.Signals | null = null;

    const signalHandlers = new Map<NodeJS.Signals, () => void>();
    const cleanup = () => {
      for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    };

    for (const signal of trackedSignals) {
      const handler = () => {
        forwardedSignal ??= signal;
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill(signal);
          } catch {
            // The child may already have received the console signal directly.
          }
        }
      };
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }

    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code, signal) => {
      cleanup();
      const effectiveSignal = signal ?? forwardedSignal;
      resolve({
        exitCode: code ?? (effectiveSignal ? exitCodeForSignal(effectiveSignal) : 1),
        signal: effectiveSignal,
      });
    });
  });
}

export async function runAndTrack(command: string, args: string[], cwd = process.cwd()): Promise<RunResult> {
  const gitRoot = await findGitRoot(cwd);
  const before = await captureSnapshot(gitRoot);
  await prepareCheckpoint(gitRoot, before, command, args);

  let outcome: { exitCode: number; signal: NodeJS.Signals | null } | undefined;
  let executionError: unknown;
  try {
    outcome = await executeCommand(command, args, cwd);
  } catch (error) {
    executionError = error;
  }

  const after = await captureSnapshot(gitRoot);
  await finalizeCheckpoint(gitRoot, after);
  if (executionError !== undefined) {
    Object.assign(executionError as object, { changes: diffSnapshots(before, after) });
    throw executionError;
  }
  if (!outcome) throw new Error("The command ended without a result.");
  return { ...diffSnapshots(before, after), ...outcome, gitRoot };
}
