import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveProjectName, findRepoRoot, currentCommitSha, dbPathFor } from "../src/project.js";

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "braindump-test-"));
  return dir;
}

describe("resolveProjectName", () => {
  it("returns the basename of a plain (non-git) directory", () => {
    const dir = makeTempRepo();
    expect(resolveProjectName(dir)).toBe(path.basename(dir));
  });

  it("returns the basename of the git repo root, not a subdirectory", () => {
    const dir = makeTempRepo();
    execSync("git init -q", { cwd: dir });
    const sub = path.join(dir, "src", "nested");
    fs.mkdirSync(sub, { recursive: true });
    expect(resolveProjectName(sub)).toBe(path.basename(dir));
  });
});

describe("findRepoRoot", () => {
  it("falls back to cwd when not inside a git repo", () => {
    const dir = makeTempRepo();
    expect(findRepoRoot(dir)).toBe(dir);
  });
});

describe("currentCommitSha", () => {
  it("returns null when there are no commits yet", () => {
    const dir = makeTempRepo();
    execSync("git init -q", { cwd: dir });
    expect(currentCommitSha(dir)).toBeNull();
  });

  it("returns the HEAD sha after a commit exists", () => {
    const dir = makeTempRepo();
    execSync("git init -q", { cwd: dir });
    execSync("git config user.email test@test.com", { cwd: dir });
    execSync("git config user.name test", { cwd: dir });
    fs.writeFileSync(path.join(dir, "a.txt"), "hi");
    execSync("git add . && git commit -q -m init", { cwd: dir });
    const sha = currentCommitSha(dir);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("dbPathFor", () => {
  it("creates the directory under the home-rooted braindump path", () => {
    const projectName = `test-project-${Date.now()}`;
    const dbPath = dbPathFor(projectName);
    expect(dbPath).toBe(
      path.join(os.homedir(), ".agents", "braindump", projectName, "graph.lbdb")
    );
    expect(fs.existsSync(path.dirname(dbPath))).toBe(true);
    fs.rmSync(path.join(os.homedir(), ".agents", "braindump", projectName), { recursive: true });
  });
});
