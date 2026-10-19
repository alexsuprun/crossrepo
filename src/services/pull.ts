import { join } from "node:path";
import type { ConfigRepoView, Ctx, RepoResult } from "../domain/ctx.ts";
import { GitError } from "../errors/index.ts";
import { folderWithoutGitResult, repoState } from "./repos.ts";

/** The hint of `repos-failed` for `xr codebase pull`. */
export const PULL_FAILED_HINT =
  "Fix each failed repo, then run `xr codebase pull` again.";

/** The repo hint for git's stderr text (with `LC_ALL=C`), by the first text that matches. */
const HINTS: readonly [RegExp, (dir: string) => string][] = [
  [
    /Not possible to fast-forward/,
    (dir) =>
      `Merge or rebase by hand in ${dir}, then run \`xr codebase pull\` again.`,
  ],
  [
    /There is no tracking information/,
    (dir) =>
      `Set an upstream for the branch in ${dir} (git branch --set-upstream-to), then run \`xr codebase pull\` again.`,
  ],
  [
    /You are not currently on a branch/,
    (dir) =>
      `Check out a branch in ${dir}, then run \`xr codebase pull\` again.`,
  ],
  [
    /would be overwritten/,
    (dir) =>
      `Commit or stash the changes in ${dir}, then run \`xr codebase pull\` again.`,
  ],
];

/**
 * The per-repo work of `xr codebase pull`, for the `perRepo` runner. A missing
 * repo is skipped and a folder with no `.git` fails, with no git call; else it
 * runs `git pull --ff-only --no-rebase` on the checked-out branch, after one git
 * version check before the first pull. git reports
 * a detached HEAD or a missing upstream itself; the hint comes from its stderr.
 */
export function pullPresent(
  ctx: Pick<Ctx, "fs" | "git">,
  codebase: string,
): (repo: ConfigRepoView, signal: AbortSignal) => Promise<RepoResult> {
  const { fs, git } = ctx;
  let versionChecked = false;
  return async (repo, signal) => {
    const { name } = repo;
    const dir = join(codebase, name);
    const state = repoState(fs, codebase, repo);
    if (state.folderWithoutGit) {
      return folderWithoutGitResult(codebase, name);
    }
    if (!state.present) {
      return {
        repo: name,
        status: "skipped",
        message: "missing",
        hint: "Clone the missing repos with `xr codebase clone`.",
      };
    }
    // Outside the `try`: a missing or old git ends the run with one error.
    if (!versionChecked) {
      await git.version();
      versionChecked = true;
    }
    try {
      await git.pull(dir, { signal });
      return { repo: name, status: "ok" };
    } catch (error) {
      if (signal.aborted) {
        return { repo: name, status: "skipped", message: "interrupted" };
      }
      if (!(error instanceof GitError)) throw error;
      const hint = HINTS.find(([text]) => text.test(error.stderr))?.[1](dir);
      return {
        repo: name,
        status: "failed",
        message: gitMessage(error.stderr) ?? error.message,
        ...(hint ? { hint } : {}),
      };
    }
  };
}

/** The first `fatal:` or `error:` line, else the first line that is not a `hint:` line. */
function gitMessage(stderr: string): string | undefined {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    lines.find((line) => /^(fatal|error):/.test(line)) ??
    lines.find((line) => !line.startsWith("hint:"))
  );
}
