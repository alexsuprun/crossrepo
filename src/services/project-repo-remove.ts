import { basename, join } from "node:path";
import type { Ctx, Tx } from "../domain/ctx.ts";
import { type HookName, hookEnv, hookVars } from "../domain/project.ts";
import { renderProjectRecord } from "../domain/project-record.ts";
import type { RepoItem } from "../domain/report.ts";
import { XrError } from "../errors/index.ts";
import { projectAgentsText, writeAgentsText } from "./agents-md.ts";
import { runHookSteps } from "./hooks.ts";
import {
  type BranchResult,
  checkUncommitted,
  deleteBranchFinal,
  isInside,
  removedRepoItem,
  removeWorktreeFinal,
  runPostRemove,
} from "./project-remove.ts";
import { type ProjectEntry, reloadProject } from "./projects.ts";

/** The flags of `xr project repo remove`. */
export interface RepoRemoveOptions {
  /** Skip the uncommitted check only (D36). */
  force: boolean;
  /** Delete each branch with `git branch -d` after its worktree. */
  deleteBranch: boolean;
}

/** What `xr project repo remove` did. */
export interface RemovedRepos {
  projectDir: string;
  branch: string;
  repos: RepoItem[];
  /** `xr` was in a removed worktree and moved to the project folder. */
  movedOut: boolean;
}

/**
 * The repos to remove: the given names, or, with none, the ones picked from
 * the repos of the project, in record order. Runs before the transaction.
 * Changes nothing.
 */
export async function repoRemoveNames(
  ctx: Pick<Ctx, "prompt">,
  project: ProjectEntry,
  args: readonly string[],
): Promise<string[]> {
  if (args.length) return [...args];
  return ctx.prompt.pickMany({
    argument: "repos",
    message: "Pick the repos to remove",
    choices: project.repos,
    missing: "Give the repos to remove.",
    listLabel: "Repos",
    hint: "xr project repo remove <repo>...",
    empty: {
      message: "The project has no repos.",
      hint: "xr project repo add <repo>...",
    },
  });
}

/**
 * The check phase and the delete phase of `xr project repo remove`, run inside
 * a transaction that holds the lock. The checks change nothing: each repo is in
 * the project, at least one repo stays, and no worktree has uncommitted
 * changes (unless `force`), `sh` is found when `pre-repo-remove` or
 * `post-repo-remove` is set, and `pre-repo-remove` passes. Then the `tx.finals`
 * steps remove the worktrees, the branches with `deleteBranch`, and only then
 * write the record and `AGENTS.md`. Last, `post-repo-remove` runs; a failed or
 * stopped line is a `hook-failed` warning. Both hooks run in the project folder.
 */
export async function removeProjectRepos(
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
  target: ProjectEntry,
  names: readonly string[],
  { force, deleteBranch }: RepoRemoveOptions,
): Promise<RemovedRepos> {
  const { fs } = ctx;
  const project = reloadProject(fs, target);
  const { path: projectDir, branch } = project;
  const worktree = (repo: string) => join(projectDir, repo);

  const unknown = names.find((name) => !project.repos.includes(name));
  if (unknown !== undefined) {
    throw new XrError({
      code: "repo-not-found",
      message: `The project ${project.name} has no repo named \`${unknown}\`.`,
      hint: `See the repos of the project with \`xr project repo list --project ${project.name}\`.`,
    });
  }
  const wanted = new Set(names);
  const repos = project.repos.filter((repo) => wanted.has(repo));
  const stay = project.repos.filter((repo) => !wanted.has(repo));
  if (!stay.length) {
    throw new XrError({
      code: "last-repo",
      message: `The project ${project.name} must keep at least one repo.`,
      hint: `To remove the whole project, run \`xr project remove ${project.name}\`.`,
    });
  }
  const missing = new Set(repos.filter((repo) => !fs.exists(worktree(repo))));
  if (!force) {
    await checkUncommitted(
      ctx,
      tx.signal,
      repos
        .filter((repo) => !missing.has(repo))
        .map((repo) => ({ repo, path: worktree(repo) })),
      {
        lead: `Removing ${repos.join(", ")}`,
        hint: `Commit or stash the changes, or run \`xr project repo remove ${repos.join(" ")} --project ${project.name}${deleteBranch ? " --delete-branch" : ""} --force\` to delete them.`,
      },
    );
  }
  const { preRepoRemove, postRepoRemove } = ctx.config;
  if (preRepoRemove.length || postRepoRemove.length) ctx.hooks.findSh();
  const env = (hook: HookName, projectRepos: readonly string[]) =>
    hookEnv(
      ctx.env,
      ctx.config.vars,
      hookVars({
        codebasePath: codebase,
        codebaseName: ctx.config.name ?? basename(codebase),
        projectPath: projectDir,
        projectName: project.name,
        branch,
        repos: projectRepos,
        changed: repos,
        hook,
      }),
      ctx.platform,
    );
  await runHookSteps(ctx, tx, "pre-repo-remove", preRepoRemove, {
    cwd: projectDir,
    env: env("pre-repo-remove", project.repos),
    cleanup: (command) => ({
      what: "pre-repo-remove hook",
      path: projectDir,
      command: `Undo by hand what \`${command}\` did, if anything.`,
    }),
  });

  const movedOut = repos.some((repo) => isInside(fs, worktree(repo), ctx.cwd));
  // Windows cannot delete the current folder of a process.
  if (movedOut) ctx.chdir(projectDir);

  const list = repos.join(", ");
  const file = join(projectDir, ".crossrepo", "project.yaml");
  const agents = join(projectDir, "AGENTS.md");
  const branchResults = new Map<string, BranchResult>();
  await tx.finals([
    ...repos.map((repo) =>
      removeWorktreeFinal(ctx, codebase, projectDir, repo, missing.has(repo)),
    ),
    ...(deleteBranch
      ? repos.map((repo) =>
          deleteBranchFinal(ctx, codebase, repo, branch, branchResults),
        )
      : []),
    {
      label: "Write project record",
      run: () =>
        fs.writeText(
          file,
          renderProjectRecord({
            branch,
            codebase,
            repos: stay,
            created: project.created,
          }),
        ),
      manualCleanup: {
        what: "project record",
        path: file,
        command: `Remove ${list} from \`repos:\` in ${file} by hand.`,
      },
    },
    {
      label: "Write AGENTS.md",
      run: () =>
        writeAgentsText(
          fs,
          agents,
          projectAgentsText(fs, {
            projectDir,
            codebaseDir: codebase,
            branch,
            repos: stay,
            configRepos: ctx.config.repos,
          }),
        ),
      manualCleanup: {
        what: "AGENTS.md",
        path: agents,
        command: `Remove the ${list} lines from the \`## Codebase\` and \`## Repos\` sections of AGENTS.md by hand.`,
      },
    },
  ]);
  await runPostRemove(ctx, tx, "post-repo-remove", postRepoRemove, {
    cwd: projectDir,
    env: env("post-repo-remove", stay),
    done:
      repos.length === 1
        ? `The repo ${list} is removed.`
        : `The repos ${list} are removed.`,
  });

  return {
    projectDir,
    branch,
    movedOut,
    repos: repos.map((repo) =>
      removedRepoItem(repo, missing.has(repo), branchResults.get(repo)),
    ),
  };
}
