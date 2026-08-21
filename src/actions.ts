import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { findGitRoot } from "./git.js";
import { inspectCheckpoint } from "./checkpoint.js";

export type ActionCategory = "filesystem" | "package-manager" | "database" | "deployment" | "infrastructure" | "network" | "unknown";
export type ActionRisk = "low" | "medium" | "high" | "critical";
export type ActionStatus = "observed" | "allowed" | "denied" | "completed" | "failed";

export type ExternalAction = {
  id: string;
  sessionId: string;
  timestamp: string;
  command: string;
  args: string[];
  cwd: string;
  category: ActionCategory;
  risk: ActionRisk;
  reversible: boolean;
  status: ActionStatus;
  exitCode?: number;
};

const packageManagers = new Set(["npm", "npm.cmd", "npx", "npx.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd"]);
const databases = new Set(["prisma", "prisma.cmd", "sequelize", "sequelize.cmd", "typeorm", "typeorm.cmd", "psql", "psql.exe", "mysql", "mysql.exe", "sqlite3", "sqlite3.exe"]);
const deployments = new Set(["vercel", "vercel.cmd", "netlify", "netlify.cmd", "firebase", "firebase.cmd"]);
const infrastructure = new Set(["kubectl", "kubectl.exe", "terraform", "terraform.exe"]);

export const interceptableCommands = [...packageManagers, ...databases, ...deployments, ...infrastructure]
  .filter((command) => process.platform === "win32" || !command.includes("."));

export function classifyAction(command: string, args: readonly string[]): Pick<ExternalAction, "category" | "risk" | "reversible"> {
  const name = path.basename(command).toLowerCase();
  const text = args.join(" ").toLowerCase();
  const delegatedIndex = name.startsWith("npx") ? 0
    : (name.startsWith("npm") || name.startsWith("pnpm") || name.startsWith("yarn")) && ["exec", "dlx"].includes(args[0]?.toLowerCase()) ? 1
      : -1;
  if (delegatedIndex >= 0 && args[delegatedIndex]) {
    const delegated = classifyAction(args[delegatedIndex], args.slice(delegatedIndex + 1));
    if (delegated.risk === "high" || delegated.risk === "critical") return delegated;
  }
  if (/\bdrop\s+(database|table)\b/.test(text) || (name.startsWith("terraform") && args[0]?.toLowerCase() === "destroy") ||
      (name.startsWith("kubectl") && args[0]?.toLowerCase() === "delete" && args[1]?.toLowerCase() === "namespace")) {
    return { category: databases.has(name) ? "database" : "infrastructure", risk: "critical", reversible: false };
  }
  if (packageManagers.has(name)) {
    const first = args[0]?.toLowerCase();
    return { category: "package-manager", risk: first === "--version" || first === "-v" || first === "help" ? "low" : "medium", reversible: false };
  }
  if (databases.has(name)) return { category: "database", risk: "high", reversible: false };
  if (deployments.has(name)) return { category: "deployment", risk: "high", reversible: false };
  if (infrastructure.has(name)) return { category: "infrastructure", risk: "high", reversible: false };
  return { category: "unknown", risk: "medium", reversible: false };
}

export function createAction(sessionId: string, command: string, args: string[], cwd: string): ExternalAction {
  return { id: randomUUID(), sessionId, timestamp: new Date().toISOString(), command, args, cwd, ...classifyAction(command, args), status: "observed" };
}

function parseAction(value: unknown, expectedSessionId?: string): ExternalAction {
  const action = value as Partial<ExternalAction>;
  const categories: ActionCategory[] = ["filesystem", "package-manager", "database", "deployment", "infrastructure", "network", "unknown"];
  const risks: ActionRisk[] = ["low", "medium", "high", "critical"];
  const statuses: ActionStatus[] = ["observed", "allowed", "denied", "completed", "failed"];
  if (!action || typeof action.id !== "string" || typeof action.sessionId !== "string" ||
      (expectedSessionId !== undefined && action.sessionId !== expectedSessionId) ||
      typeof action.timestamp !== "string" || !Number.isFinite(Date.parse(action.timestamp)) ||
      typeof action.command !== "string" || !Array.isArray(action.args) || !action.args.every((item) => typeof item === "string") ||
      typeof action.cwd !== "string" || !categories.includes(action.category as ActionCategory) ||
      !risks.includes(action.risk as ActionRisk) || typeof action.reversible !== "boolean" ||
      !statuses.includes(action.status as ActionStatus) ||
      (action.exitCode !== undefined && (!Number.isInteger(action.exitCode)))) {
    throw new Error("Malformed TimeAgent action log.");
  }
  return action as ExternalAction;
}

export async function writeAction(directory: string, action: ExternalAction): Promise<void> {
  const actionsDirectory = path.join(directory, "actions");
  await mkdir(actionsDirectory, { recursive: true });
  const destination = path.join(actionsDirectory, `${action.id}.json`);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(action), "utf8");
  await rename(temporary, destination);
}

export async function readActionsFromCheckpoint(directory: string, sessionId: string): Promise<ExternalAction[]> {
  try {
    const aggregate = JSON.parse(await readFile(path.join(directory, "actions.json"), "utf8"));
    if (!Array.isArray(aggregate)) throw new Error("Malformed TimeAgent action log.");
    return aggregate.map((item) => parseAction(item, sessionId)).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let files: string[];
  try {
    files = await readdir(path.join(directory, "actions"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const actions: ExternalAction[] = [];
  for (const file of files.filter((name) => name.endsWith(".json")).sort()) {
    actions.push(parseAction(JSON.parse(await readFile(path.join(directory, "actions", file), "utf8")), sessionId));
  }
  return actions.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export async function getActions(cwd = process.cwd()): Promise<ExternalAction[]> {
  const root = await findGitRoot(cwd);
  const checkpoint = await inspectCheckpoint(root);
  if (checkpoint.kind === "none") throw new Error("No TimeAgent session is available.");
  if (checkpoint.kind === "invalid") throw new Error(checkpoint.reason);
  const session = checkpoint.kind === "completed" ? checkpoint.manifest.session : checkpoint.session;
  return readActionsFromCheckpoint(checkpoint.directory, session.sessionId);
}

export function formatActions(actions: ExternalAction[]): string {
  if (actions.length === 0) return "No external actions observed for this session.";
  return actions.map((action) => [
    `${action.command} ${action.args.join(" ")}`.trim(),
    `  Category: ${action.category}`,
    `  Risk: ${action.risk}`,
    `  Status: ${action.status}`,
    `  Cwd: ${action.cwd}`,
    "  Reversible: no",
  ].join("\n")).join("\n\n");
}
