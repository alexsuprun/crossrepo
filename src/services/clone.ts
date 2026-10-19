import { join } from "node:path";
import type { ConfigRepoView, Ctx, RepoResult } from "../domain/ctx.ts";
import { GitError } from "../errors/index.ts";
import { folderWithoutGitResult, repoState } from "./repos.ts";

/** The hint of `repos-failed` for `xr codebase clone`. */
export const CLONE_FAILED_HINT =
  "Fix each failed repo, then run `xr codebase clone` again.";

/**
 * The per-repo work of `xr codebase clone`, for the `perRepo` runner. A repo
 * with a `.git` is skipped; a folder with no `.git` or a repo with no `remote`
 * fails; else it runs a plain `git clone`. Only a folder this call made is ever
 * deleted. git's version is checked once, before the first clone.
 */
export function cloneMissing(
  ctx: Pick<Ctx, "fs" | "git">,
  codebase: string,
): (repo: ConfigRepoView, signal: AbortSignal) => Promise<RepoResult> {
  const { fs, git } = ctx;
  let versionChecked = false;
  return async (repo, signal) => {
    const { name } = repo;
    const dir = join(codebase, name);
    const state = repoState(fs, codebase, repo);
    if (state.present) {
      return { repo: name, status: "skipped", message: "already on disk" };
    }
    if (state.folderWithoutGit) {
      return folderWithoutGitResult(codebase, name);
    }
    if (!repo.remote) {
      return {
        repo: name,
        status: "failed",
        message: "no remote in the config",
        hint: `Add \`remote\` for \`${name}\` in .crossrepo/config.yaml or .crossrepo/config.local.yaml.`,
      };
    }
    if (!versionChecked) {
      await git.version();
      versionChecked = true;
    }
    // A folder that another program made after the check is not ours to delete.
    const existed = fs.exists(dir);
    try {
      // The remote goes to git exactly as written in the config (D32).
      await git.clone(repo.remote, dir, { signal });
      return { repo: name, status: "ok" };
    } catch (error) {
      const removed = existed || tryRemove(fs, dir);
      const cleanup = `rm -r "${dir}"`;
      if (signal.aborted) {
        return {
          repo: name,
          status: "skipped",
          message: "interrupted",
          ...(removed
            ? {}
            : {
                leftover: {
                  what: "partial clone",
                  path: dir,
                  command: cleanup,
                },
              }),
        };
      }
      if (!(error instanceof GitError)) throw error;
      return {
        repo: name,
        status: "failed",
        message: firstLine(error.stderr) ?? error.message,
        ...(removed
          ? {}
          : {
              hint: `Delete the partial folder with \`${cleanup}\`, then run \`xr codebase clone\` again.`,
            }),
      };
    }
  };
}

function tryRemove(fs: Ctx["fs"], dir: string): boolean {
  try {
    fs.remove(dir);
    return true;
  } catch {
    return false;
  }
}

function firstLine(text: string): string | undefined {
  return text.trim().split(/\r?\n/)[0] || undefined;
}
