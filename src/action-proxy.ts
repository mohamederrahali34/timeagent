#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { createAction, writeAction } from "./actions.js";

async function main(argv: string[]): Promise<number> {
  const realIndex = argv.indexOf("--real");
  const nameIndex = argv.indexOf("--name");
  if (realIndex < 0 || nameIndex < 0 || !argv[realIndex + 1] || !argv[nameIndex + 1]) return 2;
  const separator = Math.max(realIndex, nameIndex) + 2;
  const real = argv[realIndex + 1];
  const command = argv[nameIndex + 1];
  const args = argv.slice(separator);
  const root = process.env.TIMEAGENT_ROOT;
  const sessionId = process.env.TIMEAGENT_SESSION_ID;
  if (!root || !sessionId) throw new Error("Missing TimeAgent interception context.");
  const action = createAction(sessionId, command, args, process.cwd());
  const pending = path.join(root, ".timeagent", "pending");
  await writeAction(pending, action);

  if (action.risk === "high" || action.risk === "critical") {
    let approved = process.env.TIMEAGENT_ALLOW_HIGH_RISK === "1";
    if (!approved && process.stdin.isTTY && process.stdout.isTTY) {
      const readline = createInterface({ input: process.stdin, output: process.stdout });
      try {
        console.log(["TimeAgent intercepted a potentially destructive action.", "", `Category: ${action.category}`, `Risk: ${action.risk}`,
          action.risk === "critical" ? "WARNING: this action may cause destructive, irreversible changes." : "", "", "Command:",
          `  ${command} ${args.join(" ")}`.trimEnd(), "", "TimeAgent rollback:", "  Not available for this external action.", ""].filter((line, index, all) => line || all[index - 1] !== "").join("\n"));
        const answer = await readline.question("Allow this command? [y/N] ");
        approved = /^(y|yes)$/i.test(answer.trim());
      } finally { readline.close(); }
    }
    if (!approved) {
      action.status = "denied";
      await writeAction(pending, action);
      console.error(`TimeAgent denied ${action.risk}-risk action: ${command} ${args.join(" ")}`.trim());
      return 77;
    }
  }
  action.status = "allowed";
  await writeAction(pending, action);
  const result = await new Promise<{ code: number; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const isWindowsScript = process.platform === "win32" && /\.(cmd|bat)$/i.test(real);
    const executable = isWindowsScript ? process.env.ComSpec ?? "cmd.exe" : real;
    const childArgs = isWindowsScript ? ["/d", "/c", "call", real, ...args] : args;
    const child = spawn(executable, childArgs, { cwd: process.cwd(), env: process.env, shell: false, stdio: "inherit", windowsVerbatimArguments: false });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code: code ?? 1, signal }));
  });
  action.exitCode = result.code;
  action.status = result.code === 0 ? "completed" : "failed";
  await writeAction(pending, action);
  return result.code;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(`timeagent action proxy: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
