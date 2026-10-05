import { execSync, execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { BraindumpError } from "./errors.js";

/**
 * Resolve a project/repo name for the current working directory.
 * Always the folder name of the repo root (or cwd, if not inside a git repo) —
 * so the brain dump folder name always matches the directory you're standing in.
 */
export function resolveProjectName(cwd = process.cwd()) {
  return path.basename(findRepoRoot(cwd));
}

/**
 * Current HEAD commit SHA for the repo containing cwd, or null if not a git
 * repo / no commits yet. Used to tag entities/relations with the commit they
 * were observed at, so staleness can be checked later ("has this file changed
 * since the commit this description was written against?").
 */
export function currentCommitSha(cwd = process.cwd()) {
  try {
    return execSync("git rev-parse HEAD", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/**
 * Find the nearest directory upward containing a .git folder, else cwd.
 */
export function findRepoRoot(cwd = process.cwd()) {
  try {
    return execSync("git rev-parse --show-toplevel", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return cwd;
  }
}

/**
 * Path to the per-project braindump database directory:
 * ~/.agents/braindump/<project>/graph.lbdb
 *
 * Global (home-rooted) so the brain dump persists across repos/machines-scope
 * and isn't tied to any single repo's working tree.
 *
 * The name comes from agents (MCP tool input), so it must be a single path
 * segment: no separators, no "."/"..", no NUL — it can never escape the
 * braindump folder.
 */
export function dbPathFor(projectName) {
  if (
    typeof projectName !== "string" ||
    projectName.trim() === "" ||
    projectName === "." ||
    projectName === ".." ||
    /[/\\\0]/.test(projectName)
  ) {
    throw new BraindumpError(
      `Invalid project name ${JSON.stringify(projectName)}: must be a single folder name ` +
        `(no "/", "\\", "." or ".."); pass "project" explicitly if auto-detection failed`
    );
  }
  const dir = path.join(os.homedir(), ".agents", "braindump", projectName);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "graph.lbdb");
}

/** Whether `sha` names a commit in the repo at `root`. */
export function commitExists(root, sha) {
  try {
    execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Which of `files` (repo-relative) differ between commit `sha` and the
 * working tree, uncommitted edits included. Paths are passed as arguments,
 * never through a shell.
 */
export function changedSince(root, sha, files) {
  const changed = new Set();
  for (let i = 0; i < files.length; i += 200) {
    const out = execFileSync("git", ["diff", "--name-only", sha, "--", ...files.slice(i, i + 200)], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    for (const line of out.toString().split("\n")) if (line) changed.add(line);
  }
  return changed;
}
