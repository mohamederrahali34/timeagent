import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { classifyAction, getActions } from "./actions.js";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve("dist", "cli.js");

async function fixture(): Promise<{ root: string; bin: string; env: NodeJS.ProcessEnv }> {
  const root = await mkdtemp(path.join(tmpdir(), "timeagent-actions-"));
  const bin = path.join(root, "fake-bin");
  await mkdir(bin);
  await execFileAsync("git", ["init"], { cwd: root });
  for (const name of ["npm", "terraform", "vercel"]) {
    const destination = path.join(bin, process.platform === "win32" ? `${name}.exe` : name);
    await copyFile(process.execPath, destination);
    if (process.platform !== "win32") await chmod(destination, 0o755);
  }
  const env = { ...process.env };
  const existingPath = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
  env.PATH = `${bin}${path.delimiter}${existingPath}`;
  return { root, bin, env };
}

function nestedSource(command: string): string {
  const invokedCommand = process.platform === "win32" ? `${command}.cmd` : command;
  return [
    "const {spawnSync}=require('node:child_process');",
    "const path=require('node:path');",
    `const tool=path.join(process.env.TIMEAGENT_ROOT,'.timeagent','pending','shims',${JSON.stringify(invokedCommand)});`,
    process.platform === "win32"
      ? "const result=spawnSync(process.env.ComSpec,['/d','/c','call',tool,...process.argv.slice(1)],{stdio:'inherit',shell:false});"
      : "const result=spawnSync(tool,process.argv.slice(1),{stdio:'inherit',shell:false});",
    "process.exit(result.status ?? 1);",
  ].join("");
}

test("classifies known, critical, and unknown actions conservatively", () => {
  assert.deepEqual(classifyAction("npm", ["install"]), { category: "package-manager", risk: "medium", reversible: false });
  assert.deepEqual(classifyAction("npm", ["--version"]), { category: "package-manager", risk: "low", reversible: false });
  assert.deepEqual(classifyAction("npx", ["prisma", "migrate", "deploy"]), { category: "database", risk: "high", reversible: false });
  assert.deepEqual(classifyAction("psql", ["-c", "DROP TABLE users"]), { category: "database", risk: "critical", reversible: false });
  assert.deepEqual(classifyAction("terraform", ["destroy"]), { category: "infrastructure", risk: "critical", reversible: false });
  assert.deepEqual(classifyAction("something-new", []), { category: "unknown", risk: "medium", reversible: false });
});

test("a real nested low-risk command is observed and allowed", async () => {
  const { root, env } = await fixture();
  try {
    await execFileAsync(process.execPath, [cliPath, "run", process.execPath, "-e", nestedSource("npm"), "--", "--version"], { cwd: root, env });
    const actions = await getActions(root);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].risk, "low");
    assert.equal(actions[0].status, "completed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a real nested process preserves args and cwd and still executes", async () => {
  const { root, env } = await fixture();
  try {
    const marker = path.join(root, "marker with spaces.txt");
    const payload = "require('node:fs').writeFileSync(process.argv[1],'executed')";
    await execFileAsync(process.execPath, [cliPath, "run", process.execPath, "-e", nestedSource("npm"), "--", "-e", payload, marker], { cwd: root, env });
    assert.equal(await readFile(marker, "utf8"), "executed");
    const actions = await getActions(root);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].command, "npm");
    assert.deepEqual(actions[0].args, ["-e", payload, marker]);
    assert.equal(path.resolve(actions[0].cwd), path.resolve(root));
    assert.equal(actions[0].status, "completed");
    assert.equal(actions[0].reversible, false);

    const output = await execFileAsync(process.execPath, [cliPath, "actions"], { cwd: root, env, encoding: "utf8" });
    assert.match(output.stdout, /Category: package-manager/);
    assert.match(output.stdout, /Status: completed/);
    const status = await execFileAsync(process.execPath, [cliPath, "status"], { cwd: root, env, encoding: "utf8" });
    assert.match(status.stdout, /External actions: 1 observed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("high-risk actions fail closed non-interactively and are not executed", async () => {
  const { root, env } = await fixture();
  try {
    const marker = path.join(root, "denied.txt");
    const payload = "require('node:fs').writeFileSync(process.argv[1],'bad')";
    await assert.rejects(execFileAsync(process.execPath, [cliPath, "run", process.execPath, "-e", nestedSource("terraform"), "--", "-e", payload, marker], { cwd: root, env }));
    await assert.rejects(readFile(marker));
    const actions = await getActions(root);
    assert.equal(actions[0].risk, "high");
    assert.equal(actions[0].status, "denied");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("explicit policy allows a high-risk action and records its result", async () => {
  const { root, env } = await fixture();
  try {
    const marker = path.join(root, "allowed.txt");
    const payload = "require('node:fs').writeFileSync(process.argv[1],'allowed')";
    await execFileAsync(process.execPath, [cliPath, "run", "--allow-high-risk", process.execPath, "-e", nestedSource("vercel"), "--", "-e", payload, marker], { cwd: root, env });
    assert.equal(await readFile(marker, "utf8"), "allowed");
    const actions = await getActions(root);
    assert.equal(actions[0].category, "deployment");
    assert.equal(actions[0].status, "completed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("malformed action logs fail safely", async () => {
  const { root, env } = await fixture();
  try {
    await execFileAsync(process.execPath, [cliPath, "run", process.execPath, "-e", ""], { cwd: root, env });
    await writeFile(path.join(root, ".timeagent", "last", "actions.json"), "[{\"bad\":true}]", "utf8");
    await assert.rejects(execFileAsync(process.execPath, [cliPath, "actions"], { cwd: root, env }), (error: unknown) =>
      /Malformed TimeAgent action log/.test((error as { stderr?: string }).stderr ?? ""));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an interrupted checkpoint preserves its atomic action log", async () => {
  const { root, env } = await fixture();
  try {
    const payload = "process.exit(0)";
    await execFileAsync(process.execPath, [cliPath, "run", process.execPath, "-e", nestedSource("npm"), "--", "-e", payload], { cwd: root, env });
    const metadata = path.join(root, ".timeagent");
    await rename(path.join(metadata, "last"), path.join(metadata, "pending"));
    await rm(path.join(metadata, "pending", "manifest.json"));
    await rm(path.join(metadata, "pending", "actions.json"));

    const actions = await getActions(root);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].status, "completed");
    const status = await execFileAsync(process.execPath, [cliPath, "status"], { cwd: root, env, encoding: "utf8" });
    assert.match(status.stdout, /State: interrupted/);
    assert.match(status.stdout, /External actions: 1 observed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
