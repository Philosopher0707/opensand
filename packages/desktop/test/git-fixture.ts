import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** Env for test git calls: hooks export GIT_DIR/GIT_INDEX_FILE, which must never reach a fixture repo. */
export function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE"]) delete env[k];
  return env;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, env: cleanGitEnv(), encoding: "utf8" }).trim();
}

/** A throwaway repo with two commits; returns the two tree ids and the file that changed. */
export function makeRepoWithChange(dir: string): { baseTree: string; finalTree: string; file: string } {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  const file = "src/a.txt";
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, file), "one\ntwo\nthree\n");
  fs.writeFileSync(path.join(dir, "other.txt"), "untouched\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  const baseTree = git(dir, "rev-parse", "HEAD^{tree}");
  fs.writeFileSync(path.join(dir, file), "one\nTWO changed\nthree\nfour\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "final");
  const finalTree = git(dir, "rev-parse", "HEAD^{tree}");
  return { baseTree, finalTree, file };
}
