import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Ctx, FinalStep, Tx } from "../domain/ctx.ts";
import { PROJECT_LIST_HINT } from "../domain/hints.ts";
import { hookEnv, hookVars } from "../domain/project.ts";
import type { RepoItem } from "../domain/report.ts";
import { GitError, XrError } from "../errors/index.ts";
import { runHookSteps } from "./hooks.ts";
import { findProject, type ProjectEntry, projectEntries } from "./projects.ts";

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
  const entries = projectEntries(ctx, codebase, { lenient: true });
  const picked = await ctx.prompt.pick({
    argument: "project",
    message: "Pick the project to remove",
    choices: entries.map((entry) => entry.name),
    hints: Object.fromEntries(
      entries.map((entry) => [entry.name, entry.branch]),
    ),
    missing: "Give the project to remove.",
    listLabel: "Projects",
    hint: "xr project remove <project>",
    empty: {
      message: "There is no project in this codebase.",
      hint: "Start one with `xr project create <branch> <repo>...`.",
    },
  });
  return entries.find((entry) => entry.name === picked) as ProjectEntry;
}

/**
 * The check phase and the delete phase of `xr project remove`, run inside a
 * transaction that holds the lock. The checks change nothing: no drift, no
 * uncommitted changes (unless `force`), `sh` found and `pre-remove` passed.
 * Then the `tx.finals` steps remove the worktrees, the branches with
 * `deleteBranch`, and the project folder last.
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
  const { fs, git } = ctx;
  const { path: projectDir, branch, repos } = project;
  const { signal } = tx;
  const repoDir = (repo: string) => join(codebase, repo);
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
    const changed: { repo: string; path: string; files: string[] }[] = [];
    for (const repo of repos) {
      if (missing.has(repo)) continue;
      const files = await git.uncommittedFiles(worktree(repo), { signal });
      if (files.length) changed.push({ repo, path: worktree(repo), files });
    }
    if (changed.length) throw uncommittedChanges(project.name, changed);
  }
  const preRemove = ctx.config.preRemove;
  if (preRemove.length) ctx.hooks.findSh();
  const env = hookEnv(
    ctx.env,
    ctx.config.vars,
    hookVars({
      codebasePath: codebase,
      codebaseName: ctx.config.name ?? basename(codebase),
      projectPath: projectDir,
      projectName: project.name,
      branch,
      repos,
      hook: "pre-remove",
    }),
    ctx.platform,
  );
  await runHookSteps(ctx, tx, "pre-remove", preRemove, {
    cwd: projectDir,
    env,
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
  const worktreeSteps: FinalStep[] = repos.map((repo) => {
    const dir = repoDir(repo);
    const path = worktree(repo);
    const gone = missing.has(repo);
    return {
      label: gone
        ? `Remove worktree ${repo} (worktree folder missing)`
        : `Remove worktree ${repo}`,
      run: () =>
        gone ? git.worktreePrune(dir) : git.worktreeRemove(dir, path),
      manualCleanup: {
        what: `worktree of ${repo}`,
        path,
        command: gone
          ? `git -C "${dir}" worktree prune`
          : `git -C "${dir}" worktree remove --force "${path}"`,
      },
    };
  });
  const branchSteps: FinalStep[] = deleteBranch
    ? repos.map((repo) => {
        const dir = repoDir(repo);
        return {
          label: `Delete branch ${repo}`,
          run: async () => {
            branchResults.set(repo, await deleteMergedBranch(ctx, dir, branch));
          },
          manualCleanup: {
            what: `branch ${branch} of ${repo}`,
            path: dir,
            command: `git -C "${dir}" branch -d ${branch}`,
          },
        };
      })
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

  return {
    projectDir,
    branch,
    movedOut,
    repos: repos.map((repo) => {
      const head = missing.has(repo)
        ? "worktree folder missing, git entry pruned"
        : "worktree removed";
      const result = branchResults.get(repo);
      if (!result) {
        return {
          repo,
          status: "ok",
          message: missing.has(repo) ? head : `${head}, branch kept`,
          branchDeleted: false,
        };
      }
      return {
        repo,
        status: "ok",
        message: `${head}, ${BRANCH_MESSAGES[result.kind]}`,
        ...(result.kind === "not-merged" ? { hint: result.hint } : {}),
        branchDeleted: result.kind === "deleted",
      };
    }),
  };
}

type BranchResult =
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
 * `project-drift` when a folder in the project folder is not a repo of the
 * record. Files and folders whose name starts with `.` (such as `.idea`) do not count.
 */
function checkDrift(
  fs: Ctx["fs"],
  projectDir: string,
  repos: readonly string[],
): void {
  const known = new Set(repos);
  const folders = fs
    .listDirs(projectDir)
    .filter((name) => !known.has(name) && !name.startsWith("."));
  if (!folders.length) return;
  const list = folders.join(", ");
  throw new XrError({
    code: "project-drift",
    message: `The project folder ${projectDir} has ${folders.length === 1 ? "a folder that is not a repo" : "folders that are not repos"} of the project: ${list}.`,
    hint: `Move ${list} out of the project folder, then run the command again.`,
    details: { path: projectDir, folders },
  });
}

function uncommittedChanges(
  name: string,
  worktrees: { repo: string; path: string; files: string[] }[],
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
    message: [
      "Removing the project would lose uncommitted changes:",
      ...lines,
    ].join("\n"),
    hint: `Commit or stash the changes, then run the command again. Or run \`xr project remove ${name} --force\` to remove the project anyway.`,
    details: { worktrees },
  });
}

/** `dir` is `folder` or inside it, with symlinks resolved when the paths exist. */
function isInside(fs: Ctx["fs"], folder: string, dir: string): boolean {
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
