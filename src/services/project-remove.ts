import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Ctx, FinalStep, Tx } from "../domain/ctx.ts";
import { PROJECT_LIST_HINT } from "../domain/hints.ts";
import { type HookName, hookEnv, hookVars } from "../domain/project.ts";
import type { RepoItem } from "../domain/report.ts";
import { GitError, XrError } from "../errors/index.ts";
import { hookWarning, runHookSteps } from "./hooks.ts";
import { findProject, type ProjectEntry, pickProject } from "./projects.ts";

/** The flags of `xr project remove`. */
export interface ProjectRemoveOptions {
  /** Skip the uncommitted check only (D36). */
  force: boolean;
  /** Delete each branch with `git branch -d` after its worktree. */
  deleteBranch: boolean;
}

/** What `xr project remove` did. */
export interface RemovedProject {
  projectDir: string;
  branch: string;
  repos: RepoItem[];
  /** `xr` was in the project folder and moved to the codebase. */
  movedOut: boolean;
}

/** The most uncommitted file names the `uncommitted-changes` message shows per worktree. */
const SHOWN_FILES = 5;

/**
 * The project to remove: the one named (folder name, else branch), or, with no
 * name, the one picked from the project folder names with their branches as
 * hints. Never the current project without a name or a pick. Runs before the
 * transaction, so no lock is held while the user picks. Changes nothing.
 */
export async function removeTarget(
  ctx: Pick<Ctx, "fs" | "config" | "out" | "prompt">,
  codebase: string,
  args: readonly (string | undefined)[],
): Promise<ProjectEntry> {
  const [name] = args;
  if (name !== undefined) {
    return findProject(ctx, codebase, name, { lenient: true });
  }
  return pickProject(ctx, codebase, {
    message: "Pick the project to remove",
    missing: "Give the project to remove.",
    hint: "xr project remove <project>",
  });
}

/**
 * The check phase and the delete phase of `xr project remove`, run inside a
 * transaction that holds the lock. The checks change nothing: no drift, no
 * uncommitted changes (unless `force`), `sh` found when `pre-remove` or
 * `post-remove` is set, and `pre-remove` passed. Then the `tx.finals` steps
 * remove the worktrees, the branches with `deleteBranch`, and the project
 * folder last. Last, `post-remove` runs in the codebase folder; a failed or
 * stopped line is a `hook-failed` warning, not an error.
 */
export async function removeProject(
  ctx: Pick<
    Ctx,
    | "fs"
    | "git"
    | "out"
    | "config"
    | "hooks"
    | "env"
    | "platform"
    | "cwd"
    | "chdir"
  >,
  tx: Tx,
  codebase: string,
  project: ProjectEntry,
  { force, deleteBranch }: ProjectRemoveOptions,
): Promise<RemovedProject> {
  const { fs } = ctx;
  const { path: projectDir, branch, repos } = project;
  const { signal } = tx;
  const worktree = (repo: string) => join(projectDir, repo);

  if (!fs.exists(join(projectDir, ".crossrepo", "project.yaml"))) {
    throw new XrError({
      code: "project-not-found",
      message: `The project ${project.name} is gone.`,
      hint: `Run \`${PROJECT_LIST_HINT}\` to see the projects.`,
      details: { project: project.name },
    });
  }
  checkDrift(fs, projectDir, repos);
  const missing = new Set(repos.filter((repo) => !fs.exists(worktree(repo))));
  if (!force) {
    await checkUncommitted(
      ctx,
      signal,
      repos
        .filter((repo) => !missing.has(repo))
        .map((repo) => ({ repo, path: worktree(repo) })),
      {
        lead: "Removing the project",
        hint: `Commit or stash the changes, then run the command again. Or run \`xr project remove ${project.name} --force\` to remove the project anyway.`,
      },
    );
  }
  const { preRemove, postRemove } = ctx.config;
  if (preRemove.length || postRemove.length) ctx.hooks.findSh();
  const env = (hook: HookName) =>
    hookEnv(
      ctx.env,
      ctx.config.vars,
      hookVars({
        codebasePath: codebase,
        codebaseName: ctx.config.name ?? basename(codebase),
        projectPath: projectDir,
        projectName: project.name,
        branch,
        repos,
        hook,
      }),
      ctx.platform,
    );
  await runHookSteps(ctx, tx, "pre-remove", preRemove, {
    cwd: projectDir,
    env: env("pre-remove"),
    cleanup: (command) => ({
      what: "pre-remove hook",
      path: projectDir,
      command: `Undo by hand what \`${command}\` did, if anything.`,
    }),
  });

  const movedOut = isInside(fs, projectDir, ctx.cwd);
  // Windows cannot delete the current folder of a process.
  if (movedOut) ctx.chdir(codebase);

  const branchResults = new Map<string, BranchResult>();
  const worktreeSteps = repos.map((repo) =>
    removeWorktreeFinal(ctx, codebase, projectDir, repo, missing.has(repo)),
  );
  const branchSteps = deleteBranch
    ? repos.map((repo) =>
        deleteBranchFinal(ctx, codebase, repo, branch, branchResults),
      )
    : [];
  await tx.finals([
    ...worktreeSteps,
    ...branchSteps,
    {
      label: "Remove project folder",
      run: () => fs.remove(projectDir),
      manualCleanup: {
        what: "project folder",
        path: projectDir,
        command: `rm -rf "${projectDir}"`,
      },
    },
  ]);
  await runPostRemove(ctx, tx, postRemove, codebase, env("post-remove"));

  return {
    projectDir,
    branch,
    movedOut,
    repos: repos.map((repo) =>
      removedRepoItem(repo, missing.has(repo), branchResults.get(repo)),
    ),
  };
}

/**
 * The `post-remove` lines, one at a time, after the delete phase. The first
 * failed line, or a Ctrl-C, ends the hook with a `hook-failed` warning: the
 * project is gone, so nothing can be undone and the remove still succeeds.
 */
async function runPostRemove(
  ctx: Pick<Ctx, "hooks" | "out">,
  tx: Tx,
  lines: readonly string[],
  codebase: string,
  env: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [index, command] of lines.entries()) {
    try {
      await runHookSteps(ctx, tx, "post-remove", [command], {
        cwd: codebase,
        env,
        cleanup: (line) => ({
          what: "post-remove hook",
          path: codebase,
          command: `Undo by hand what \`${line}\` did, if anything.`,
        }),
      });
    } catch (error) {
      const warning = hookWarning("post-remove", error, lines.slice(index));
      if (!warning) throw error;
      ctx.out.emit({ type: "warning", warning });
      return;
    }
  }
}

/**
 * The "Remove worktree `<repo>`" final step: `git worktree remove --force`, or
 * `git worktree prune` when the worktree folder is `gone`.
 */
export function removeWorktreeFinal(
  ctx: Pick<Ctx, "git">,
  codebase: string,
  projectDir: string,
  repo: string,
  gone: boolean,
): FinalStep {
  const dir = join(codebase, repo);
  const path = join(projectDir, repo);
  return {
    label: gone
      ? `Remove worktree ${repo} (worktree folder missing)`
      : `Remove worktree ${repo}`,
    run: () =>
      gone ? ctx.git.worktreePrune(dir) : ctx.git.worktreeRemove(dir, path),
    manualCleanup: {
      what: `worktree of ${repo}`,
      path,
      command: gone
        ? `git -C "${dir}" worktree prune`
        : `git -C "${dir}" worktree remove --force "${path}"`,
    },
  };
}

/** The "Delete branch `<repo>`" final step (see `deleteMergedBranch`). Its result goes to `results`. */
export function deleteBranchFinal(
  ctx: Pick<Ctx, "git" | "out">,
  codebase: string,
  repo: string,
  branch: string,
  results: Map<string, BranchResult>,
): FinalStep {
  const dir = join(codebase, repo);
  return {
    label: `Delete branch ${repo}`,
    run: async () => {
      results.set(repo, await deleteMergedBranch(ctx, dir, branch));
    },
    manualCleanup: {
      what: `branch ${branch} of ${repo}`,
      path: dir,
      command: `git -C "${dir}" branch -d ${branch}`,
    },
  };
}

/** The `repos` item of a removed worktree. `branch` is the result of its branch step, if it ran. */
export function removedRepoItem(
  repo: string,
  missing: boolean,
  branch: BranchResult | undefined,
): RepoItem {
  const head = missing
    ? "worktree folder missing, git entry pruned"
    : "worktree removed";
  if (!branch) {
    return {
      repo,
      status: "ok",
      message: missing ? head : `${head}, branch kept`,
      branchDeleted: false,
    };
  }
  return {
    repo,
    status: "ok",
    message: `${head}, ${BRANCH_MESSAGES[branch.kind]}`,
    ...(branch.kind === "not-merged" ? { hint: branch.hint } : {}),
    branchDeleted: branch.kind === "deleted",
  };
}

/** What the branch step of a repo did. */
export type BranchResult =
  | { kind: "deleted" }
  | { kind: "gone" }
  | { kind: "not-merged"; hint: string };

const BRANCH_MESSAGES: Record<BranchResult["kind"], string> = {
  deleted: "branch deleted",
  gone: "branch already gone",
  "not-merged": "branch kept: not merged",
};

/**
 * `git branch -d`, never `-D`. A branch git refuses as not merged is kept with
 * a `branch-not-merged` warning; a branch that is not there is not an error.
 */
async function deleteMergedBranch(
  ctx: Pick<Ctx, "git" | "out">,
  dir: string,
  branch: string,
): Promise<BranchResult> {
  if (!(await ctx.git.localBranchExists(dir, branch))) return { kind: "gone" };
  try {
    await ctx.git.branchDelete(dir, branch, { force: false });
    return { kind: "deleted" };
  } catch (error) {
    // git runs with `LC_ALL=C`, so the text is stable.
    if (
      !(error instanceof GitError) ||
      error.exitCode !== 1 ||
      !error.stderr.includes("not fully merged")
    ) {
      throw error;
    }
    const hint = `git -C "${dir}" branch -D ${branch}`;
    ctx.out.emit({
      type: "warning",
      warning: {
        code: "branch-not-merged",
        message: `The branch ${branch} of ${dir} is not merged, so it was kept.`,
        hint: `To delete it anyway, run \`${hint}\`.`,
      },
    });
    return { kind: "not-merged", hint };
  }
}

/**
 * The folders in the project folder that are not repos of the record, in name
 * order. Files and folders whose name starts with `.` (such as `.idea`) do not count.
 */
export function driftFolders(
  fs: Ctx["fs"],
  projectDir: string,
  repos: readonly string[],
): string[] {
  const known = new Set(repos);
  return fs
    .listDirs(projectDir)
    .filter((name) => !known.has(name) && !name.startsWith("."));
}

/** `project-drift` when `driftFolders` finds a folder. */
function checkDrift(
  fs: Ctx["fs"],
  projectDir: string,
  repos: readonly string[],
): void {
  const folders = driftFolders(fs, projectDir, repos);
  if (!folders.length) return;
  const list = folders.join(", ");
  throw new XrError({
    code: "project-drift",
    message: `The project folder ${projectDir} has ${folders.length === 1 ? "a folder that is not a repo" : "folders that are not repos"} of the project: ${list}.`,
    hint: `Move ${list} out of the project folder, then run the command again.`,
    details: { path: projectDir, folders },
  });
}

/** The texts of the `uncommitted-changes` error. */
export interface UncommittedTexts {
  /** The start of the message, such as `Removing the project`. */
  lead: string;
  hint: string;
}

/**
 * `uncommitted-changes` when a worktree has changed, staged or untracked files
 * that are not ignored (D36). Reads only.
 */
export async function checkUncommitted(
  ctx: Pick<Ctx, "git">,
  signal: AbortSignal,
  worktrees: readonly { repo: string; path: string }[],
  texts: UncommittedTexts,
): Promise<void> {
  const changed: { repo: string; path: string; files: string[] }[] = [];
  for (const { repo, path } of worktrees) {
    const files = await ctx.git.uncommittedFiles(path, { signal });
    if (files.length) changed.push({ repo, path, files });
  }
  if (changed.length) throw uncommittedChanges(changed, texts);
}

function uncommittedChanges(
  worktrees: { repo: string; path: string; files: string[] }[],
  { lead, hint }: UncommittedTexts,
): XrError {
  const lines = worktrees.map(({ repo, path, files }) => {
    const shown = files.slice(0, SHOWN_FILES).join(", ");
    const more =
      files.length > SHOWN_FILES
        ? ` and ${files.length - SHOWN_FILES} more`
        : "";
    const count = `${files.length} uncommitted ${files.length === 1 ? "file" : "files"}`;
    return `  ${repo} (${path}): ${count} (${shown}${more})`;
  });
  return new XrError({
    code: "uncommitted-changes",
    message: [`${lead} would lose uncommitted changes:`, ...lines].join("\n"),
    hint,
    details: { worktrees },
  });
}

/** `dir` is `folder` or inside it, with symlinks resolved when the paths exist. */
export function isInside(fs: Ctx["fs"], folder: string, dir: string): boolean {
  const real = (path: string) => {
    try {
      return fs.realpath(path);
    } catch {
      return resolve(path);
    }
  };
  const rel = relative(real(folder), real(dir));
  return !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}
