import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function findGitRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd, encoding: "utf8" },
    );
    return stdout.trim();
  } catch {
    throw new Error("The current directory is not inside a Git repository.");
  }
}
