import { join } from "node:path";
import type { Ctx, RepoResult } from "../domain/ctx.ts";
import { GitError, XrError } from "../errors/index.ts";
import { defaultBranch } from "./default-branch.ts";
import type { ProjectEntry } from "./projects.ts";
import { gitMessage, pullHint } from "./pull.ts";

/** The hint of `repos-failed` for `xr project sync`. */
export const SYNC_FAILED_HINT =
  "Fix each failed or conflicted repo, then run `xr project sync` again.";

/** The most conflict file names a message shows. */
const SHOWN_FILES = 5;

/**
 * The per-repo work of `xr project sync`, for the `perRepo` runner. Before any
 * git write, a repo fails when its worktree folder is missing, it is not on the
 * project branch, a merge is in progress, it has unmerged files, or it has no
 * default branch. Then `git fetch origin` (stopped by Ctrl-C), then
 * `mergeAutostash` of `origin/<default branch>`, which never gets the signal: a
 * merge in flight ends.
 * Never switches branches; a conflict stays in git's conflict state (D35).
 */
export function syncRepo(
  ctx: Pick<Ctx, "fs" | "git" | "config">,
  codebase: string,
  project: ProjectEntry,
): (repo: { name: string }, signal: AbortSignal) => Promise<RepoResult> {
  const { fs, git } = ctx;
  let versionChecked = false;
  return async ({ name }, signal) => {
    const path = join(project.path, name);
    const failed = (message: string, hint?: string): RepoResult => ({
      repo: name,
      status: "failed",
      message,
      ...(hint ? { hint } : {}),
    });
    const interrupted: RepoResult = {
      repo: name,
      status: "skipped",
      message: "interrupted",
    };
    if (!fs.exists(path)) {
      return failed("worktree folder missing", "xr project doctor");
    }
    // Outside the `try`: a missing or old git ends the run with one error.
    if (!versionChecked) {
      await git.version();
      versionChecked = true;
    }
    try {
      const branch = await git.currentBranch(path, { signal });
      if (branch !== project.branch) {
        return failed(
          branch === undefined
            ? "detached HEAD"
            : `on branch \`${branch}\`, not \`${project.branch}\``,
          `Run \`git -C "${path}" switch ${project.branch}\`.`,
        );
      }
      if (await git.mergeInProgress(path, { signal })) {
        return failed(
          "merge in progress",
          `Run \`git -C "${path}" merge --continue\` or \`git -C "${path}" merge --abort\`.`,
        );
      }
      const unmerged = await git.unmergedFiles(path, { signal });
      if (unmerged.length) {
        return {
          ...failed(
            `unmerged files: ${fileList(unmerged)}`,
            `Fix the files, then run \`git -C "${path}" reset\`; if \`git stash list\` has the \`autostash\` entry of sync, run \`git -C "${path}" stash drop\`.`,
          ),
          files: unmerged,
        };
      }
      let target: string;
      try {
        target = await defaultBranch(ctx, name, join(codebase, name), signal);
      } catch (error) {
        if (error instanceof XrError && error.code === "no-default-branch") {
          return failed(error.message, error.hint);
        }
        throw error;
      }
      try {
        await git.fetch(path, { signal });
      } catch (error) {
        if (signal.aborted) return interrupted;
        if (!(error instanceof GitError)) throw error;
        return failed(
          gitMessage(error.stderr) ?? error.message,
          pullHint(error.stderr, path),
        );
      }
      if (signal.aborted) return interrupted;
      const ref = `origin/${target}`;
      // No signal: Ctrl-C must never stop a merge half way. The full ref: a
      // local branch or tag named `origin/<b>` would make the short one ambiguous.
      const merge = await git.mergeAutostash(path, `refs/remotes/${ref}`);
      if (merge.stashKept) {
        return {
          repo: name,
          status: "conflict",
          message: `merged ${ref}, but your changes conflict with it: they stay in \`git stash list\``,
          // git already applied the stash with conflicts, so `stash pop` fails.
          hint: `Fix the files, then run \`git -C "${path}" reset\` and \`git -C "${path}" stash drop\`.`,
          files: await git.unmergedFiles(path),
          stashKept: true,
        };
      }
      if (merge.result === "conflict") {
        return {
          repo: name,
          status: "conflict",
          message: conflictMessage(merge.files),
          hint: `Fix the files, then run \`git -C "${path}" merge --continue\`, or run \`git -C "${path}" merge --abort\`.`,
          files: merge.files,
        };
      }
      return {
        repo: name,
        status: "ok",
        message:
          merge.result === "up-to-date"
            ? "up to date"
            : merge.fastForward
              ? `fast-forwarded to ${ref}`
              : `merged ${ref}`,
      };
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      if (signal.aborted) return interrupted;
      return failed(gitMessage(error.stderr) ?? error.message);
    }
  };
}

/** Such as "merge conflict in 2 files: `a`, `b`". */
function conflictMessage(files: readonly string[]): string {
  return `merge conflict in ${files.length} ${files.length === 1 ? "file" : "files"}: ${fileList(files)}`;
}

/** Such as "`a`, `b`": at most 5 names, then "and N more". */
function fileList(files: readonly string[]): string {
  const shown = files
    .slice(0, SHOWN_FILES)
    .map((file) => `\`${file}\``)
    .join(", ");
  const rest = files.length - SHOWN_FILES;
  return `${shown}${rest > 0 ? ` and ${rest} more` : ""}`;
}
