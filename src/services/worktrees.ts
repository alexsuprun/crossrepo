import type { BranchSource, Ctx, Tx } from "../domain/ctx.ts";

/** How a worktree gets its branch, with the `repos` block message. */
export interface BranchChoice {
  source: BranchSource;
  message: string;
  /** For `tracking` and `new`: where the new branch starts. */
  startPoint?: string;
}

/**
 * The branch of a new worktree (D37): the local branch when it exists, else a
 * new branch that tracks `origin/<branch>`, else a new branch from
 * `origin/<defaultBranch>`. Reads only.
 */
export async function chooseBranch(
  git: Ctx["git"],
  repoDir: string,
  branch: string,
  defaultBranch: string,
  options?: { signal?: AbortSignal },
): Promise<BranchChoice> {
  if (await git.localBranchExists(repoDir, branch, options)) {
    return { source: "local", message: "local branch" };
  }
  if (await git.remoteBranchExists(repoDir, branch, options)) {
    const startPoint = `origin/${branch}`;
    return {
      source: "tracking",
      message: `tracking ${startPoint}`,
      startPoint,
    };
  }
  const startPoint = `origin/${defaultBranch}`;
  return {
    source: "new",
    message: `new branch from ${startPoint}`,
    startPoint,
  };
}

/** One worktree to add. */
export interface WorktreeTarget {
  repo: string;
  repoDir: string;
  /** The worktree folder: `<project>/<repo>`. */
  path: string;
  branch: string;
  choice: BranchChoice;
}

/**
 * The "Add worktree `<repo>`" step. A failed add removes its folder, prunes, and
 * deletes a branch it made from the default branch, then throws. The undo
 * removes the worktree and deletes the branch only for `new`: a branch that
 * existed, or that tracks `origin`, stays (CAP-4).
 */
export async function addWorktreeStep(
  ctx: Pick<Ctx, "fs" | "git">,
  tx: Tx,
  { repo, repoDir, path, branch, choice }: WorktreeTarget,
): Promise<void> {
  const { fs, git } = ctx;
  const isNew = choice.source === "new";
  const removeCommand = `git -C "${repoDir}" worktree remove --force "${path}"`;
  const deleteCommand = `git -C "${repoDir}" branch -D "${branch}"`;
  const deleteNewBranch = () =>
    git.branchDelete(repoDir, branch, { force: true });
  await tx.step(
    `Add worktree ${repo}`,
    async (signal) => {
      try {
        await git.worktreeAdd(
          repoDir,
          path,
          { branch, source: choice.source, startPoint: choice.startPoint },
          { signal },
        );
      } catch (error) {
        // The step has no undo yet, so a partial add is cleaned here; the add error is the one to report.
        await cleanUpFailedAdd();
        throw error;
      }
    },
    async () => {
      await git.worktreeRemove(repoDir, path);
      if (isNew) await deleteNewBranch();
    },
    {
      what: `worktree of ${repo}`,
      path,
      command: isNew ? `${removeCommand} && ${deleteCommand}` : removeCommand,
    },
  );

  async function cleanUpFailedAdd(): Promise<void> {
    try {
      fs.remove(path);
      await git.worktreePrune(repoDir);
      if (isNew && (await git.localBranchExists(repoDir, branch))) {
        await deleteNewBranch();
      }
    } catch {
      // Best effort.
    }
  }
}
