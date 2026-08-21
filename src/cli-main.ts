import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { formatSummary } from "./format.js";
import { runAndTrack } from "./runner.js";
import { undoLast, type ConfirmUndo, type UndoConfirmation } from "./undo.js";
import { formatStatus, getStatus } from "./status.js";
import { formatDiffSummary, formatPatch, getSessionDiff } from "./session-diff.js";
import { formatActions, getActions } from "./actions.js";

const usage = "Usage: timeagent run [--allow-high-risk] <command> [args...]\n       timeagent undo [--yes]\n       timeagent status\n       timeagent diff [--patch]\n       timeagent actions";

export type RunInvocation = { command: string; args: string[]; allowHighRisk?: true };

export function parseRunInvocation(argv: string[]): RunInvocation | undefined {
  if (argv[0] !== "run") return undefined;
  const allowHighRisk = argv[1] === "--allow-high-risk";
  const commandIndex = allowHighRisk ? 2 : 1;
  if (!argv[commandIndex]) return undefined;
  return allowHighRisk
    ? { command: argv[commandIndex], args: argv.slice(commandIndex + 1), allowHighRisk: true }
    : { command: argv[commandIndex], args: argv.slice(commandIndex + 1) };
}

function printChangeCounts(context: UndoConfirmation): void {
  if (context.interrupted) {
    console.log("Interrupted TimeAgent session detected.\n");
    console.log(`Command: ${[context.session.command, ...context.session.args].join(" ")}`);
    console.log(`Started: ${context.session.startedAt}`);
    console.log("Recovery checkpoint is available.\n");
    console.log("Current changes since the checkpoint:");
  } else {
    console.log("Files changed after the session completed:");
  }
  console.log(`  Created: ${context.changes.created.length}`);
  console.log(`  Modified: ${context.changes.modified.length}`);
  console.log(`  Deleted: ${context.changes.deleted.length}\n`);
}

const confirmUndo: ConfirmUndo = async (_changes, context) => {
  printChangeCounts(context);
  if (!input.isTTY || !output.isTTY) return false;
  const readline = createInterface({ input, output });
  try {
    const question = context.interrupted
      ? "Restore the repository to its pre-session state? [y/N] "
      : "Overwrite these later changes and continue? [y/N] ";
    const answer = await readline.question(question);
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    readline.close();
  }
};

export async function main(argv: string[]): Promise<number> {
  const [subcommand, command, ...extra] = argv;
  if (subcommand === "undo" && (command === undefined || command === "--yes") && extra.length === 0) {
    try {
      await undoLast(process.cwd(), confirmUndo, command === "--yes");
      console.log("Pre-session state restored successfully.");
      return 0;
    } catch (error) {
      console.error(`timeagent: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  if (subcommand === "status" && command === undefined) {
    try {
      console.log(formatStatus(await getStatus()));
      return 0;
    } catch (error) {
      console.error(`timeagent: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  if (subcommand === "diff" && (command === undefined || command === "--patch") && extra.length === 0) {
    try {
      const report = await getSessionDiff();
      console.log(formatDiffSummary(report));
      if (command === "--patch") {
        const patch = await formatPatch(report);
        if (patch) console.log(`\n${patch}`);
      }
      return 0;
    } catch (error) {
      console.error(`timeagent: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  if (subcommand === "actions" && command === undefined) {
    try {
      console.log(formatActions(await getActions()));
      return 0;
    } catch (error) {
      console.error(`timeagent: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  const invocation = parseRunInvocation(argv);
  if (!invocation) {
    console.error(usage);
    return 2;
  }

  try {
    const result = await runAndTrack(invocation.command, invocation.args, process.cwd(), invocation.allowHighRisk === true);
    console.log(formatSummary(result));
    if (result.signal) console.error(`Command interrupted by signal ${result.signal}.`);
    return result.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`timeagent: ${message}`);
    const changes = (error as { changes?: Parameters<typeof formatSummary>[0] }).changes;
    if (changes) console.log(formatSummary(changes));
    return 1;
  }
}
