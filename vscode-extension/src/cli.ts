import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

export type ExecResult = { stdout: string; stderr: string; exitCode: number };
export type ExecAdapter = (file: string, args: readonly string[], cwd?: string) => Promise<ExecResult>;

async function pathExists(file: string): Promise<boolean> {
  try { return (await stat(file)).isFile(); } catch { return false; }
}

export async function resolveExecutable(file: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (path.isAbsolute(file) || file.includes(path.sep)) return await pathExists(file) ? file : undefined;
  const pathEntry = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  const pathExt = Object.entries(env).find(([key]) => key.toLowerCase() === "pathext")?.[1];
  const extensions = process.platform === "win32"
    ? (pathExt ?? ".COM;.EXE;.BAT;.CMD").split(";").map((extension) => extension.toLowerCase())
    : [""];
  for (const directory of pathEntry.split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, file.toLowerCase().endsWith(extension) ? file : `${file}${extension}`);
      if (await pathExists(candidate)) return candidate;
    }
  }
  return undefined;
}

export type AgentAvailability = { command: AgentChoice; available: boolean; executable?: string };

export async function detectAgent(command: AgentChoice, env: NodeJS.ProcessEnv = process.env): Promise<AgentAvailability> {
  const executable = await resolveExecutable(command, env);
  return { command, available: executable !== undefined, ...(executable ? { executable } : {}) };
}

export async function detectAgents(env: NodeJS.ProcessEnv = process.env): Promise<Record<AgentChoice, AgentAvailability>> {
  const [codex, claude] = await Promise.all([detectAgent("codex", env), detectAgent("claude", env)]);
  return { codex, claude };
}

export function canLaunchAgent(availability: AgentAvailability): boolean { return availability.available; }

export function detectedAgentSessionArgs(availability: AgentAvailability): string[] | undefined {
  return canLaunchAgent(availability) ? protectedSessionArgs(availability.command) : undefined;
}

const defaultExec: ExecAdapter = async (file, args, cwd) => {
  const resolved = await resolveExecutable(file);
  if (!resolved) throw Object.assign(new Error(`${file} was not found on PATH.`), { code: "ENOENT" });
  const isWindowsScript = process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved);
  const executable = isWindowsScript ? process.env.ComSpec ?? "cmd.exe" : resolved;
  const childArgs = isWindowsScript ? ["/d", "/c", "call", resolved, ...args] : [...args];
  return new Promise((resolve, reject) => execFile(executable, childArgs, { cwd, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
    if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      reject(error);
      return;
    }
    resolve({ stdout, stderr, exitCode: error && typeof error.code === "number" ? error.code : 0 });
  }));
};

export async function detectTimeAgent(execute: ExecAdapter = defaultExec): Promise<boolean> {
  try {
    await execute("timeagent", ["--help"]);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

export async function executeTimeAgent(args: readonly string[], cwd: string, execute: ExecAdapter = defaultExec): Promise<ExecResult> {
  return execute("timeagent", args, cwd);
}

export type AgentChoice = "codex" | "claude";

export function protectedSessionArgs(agent: AgentChoice): string[] {
  return ["run", agent];
}

export function parseCustomCommand(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaping = false;
  for (const character of value.trim()) {
    if (escaping) { current += character; escaping = false; continue; }
    if (character === "\\" && quote === "\"") { escaping = true; continue; }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === "'" || character === "\"") { quote = character; continue; }
    if (/\s/.test(character)) {
      if (current) { tokens.push(current); current = ""; }
    } else current += character;
  }
  if (quote) throw new Error("The custom command contains an unmatched quote.");
  if (escaping) current += "\\";
  if (current) tokens.push(current);
  if (tokens.length === 0) throw new Error("Enter a command to run.");
  return tokens;
}

function quoteTerminalArgument(value: string, platform: NodeJS.Platform): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  if (platform === "win32") return `"${value.replaceAll("\"", "\"\"")}"`;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function buildTerminalCommand(args: readonly string[], platform: NodeJS.Platform = process.platform): string {
  return ["timeagent", ...args].map((argument) => quoteTerminalArgument(argument, platform)).join(" ");
}
