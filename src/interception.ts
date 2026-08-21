import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { interceptableCommands } from "./actions.js";
import type { SessionMetadata } from "./checkpoint.js";

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}

async function resolveExecutable(command: string, searchPath: string): Promise<string | undefined> {
  const extensions = process.platform === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""];
  for (const directory of searchPath.split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, command.toLowerCase().endsWith(extension) ? command : `${command}${extension}`);
      if (await exists(candidate)) return path.resolve(candidate);
    }
  }
  return undefined;
}

export async function prepareInterception(root: string, session: SessionMetadata, allowHighRisk: boolean): Promise<NodeJS.ProcessEnv> {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const originalPath = process.env[pathKey] ?? "";
  const shimDirectory = path.join(root, ".timeagent", "pending", "shims");
  await mkdir(shimDirectory, { recursive: true });
  const proxyPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "action-proxy.js");

  for (const name of new Set(interceptableCommands.map((item) => item.replace(/\.(cmd|exe)$/i, "")))) {
    const real = await resolveExecutable(name, originalPath);
    if (!real) continue;
    if (process.platform === "win32") {
      const body = `@echo off\r\n"${process.execPath}" "${proxyPath}" --real "${real}" --name "${name}" %*\r\nexit /b %errorlevel%\r\n`;
      await writeFile(path.join(shimDirectory, `${name}.cmd`), body, "utf8");
    } else {
      const body = `#!/bin/sh\nexec ${quotePosix(process.execPath)} ${quotePosix(proxyPath)} --real ${quotePosix(real)} --name ${quotePosix(name)} "$@"\n`;
      const file = path.join(shimDirectory, name);
      await writeFile(file, body, "utf8");
      await chmod(file, 0o755);
    }
  }
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
  env[pathKey] = `${shimDirectory}${path.delimiter}${originalPath}`;
  env.TIMEAGENT_ROOT = root;
  env.TIMEAGENT_SESSION_ID = session.sessionId;
  env.TIMEAGENT_ALLOW_HIGH_RISK = allowHighRisk ? "1" : "0";
  return env;
}
