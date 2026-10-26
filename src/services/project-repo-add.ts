import { join } from "node:path";
import type { Ctx, Tx } from "../domain/ctx.ts";
import type { RepoItem } from "../domain/report.ts";
import { XrError } from "../errors/index.ts";
import { projectAgentsText, writeAgentsStep } from "./agents-md.ts";
import {
  CLONE_HINT,
  checkKnownRepos,
  checkReposOnDisk,
  checkWorktreeRepos,
  chooseBranches,
} from "./project-create.ts";
import {
  type ProjectEntry,
  reloadProject,
  writeProjectRecordStep,
} from "./projects.ts";
import { repoStates } from "./repos.ts";
import { addWorktreeStep, type BranchChoice } from "./worktrees.ts";

/** What `xr project repo add` added. */
export interface AddedRepos {
  projectDir: string;
  branch: string;
  repos: RepoItem[];
}

/**
 * The repos to add: the given names, or, with none, the ones picked from the
 * repos of the merged config that are on disk and not in the project, in
 * config order. Runs before the transaction. Changes nothing.
 */
export async function repoAddNames(
  ctx: Pick<Ctx, "fs" | "config" | "prompt">,
  codebase: string,
  project: ProjectEntry,
  args: readonly string[],
): Promise<string[]> {
  if (args.length) return [...args];
  const inProject = new Set(project.repos);
  return ctx.prompt.pickMany({
    argument: "repos",
    message: "Pick the repos to add",
    choices: repoStates(ctx, codebase)
      .filter((state) => state.present && !inProject.has(state.name))
      .map(({ name }) => name),
    missing: "Give the repos to add.",
    listLabel: "Repos",
    hint: "xr project repo add <repo>...",
    empty: {
      message: "Every repo on disk is in the project already.",
      hint: CLONE_HINT,
    },
  });
}

/**
 * The checks and steps of `xr project repo add`, run inside a transaction that
 * holds the lock. The checks change nothing: each repo is known, on disk, not
 * in the project, has no folder or file at its worktree path, fetches, has a
 * default branch, and does not have the branch checked out. Then the steps add
 * the worktrees, write the record and `AGENTS.md`. Runs no hook (AD-11).
 */
export async function addProjectRepos(
  ctx: Pick<Ctx, "fs" | "git" | "out" | "config">,
  tx: Tx,
  codebase: string,
  target: ProjectEntry,
  names: readonly string[],
): Promise<AddedRepos> {
  const { fs } = ctx;
  const project = reloadProject(fs, target);
  const { path: projectDir, branch } = project;
  const { signal } = tx;

  const states = repoStates(ctx, codebase);
  checkKnownRepos(states, names);
  const wanted = new Set(names);
  const chosen = states.filter(({ name }) => wanted.has(name));
  checkReposOnDisk(chosen);
  const repos = chosen.map(({ name }) => name);
  const already = repos.find((repo) => project.repos.includes(repo));
  if (already !== undefined) {
    throw new XrError({
      code: "repo-already-in-project",
      message: `\`${already}\` is in the project ${project.name} already.`,
      hint: `See the repos of the project with \`xr project repo list --project ${project.name}\`.`,
      details: { repo: already },
    });
  }
  const taken = repos.filter((repo) => fs.exists(join(projectDir, repo)));
  if (taken.length) {
    const list = taken.join(", ");
    throw new XrError({
      code: "project-drift",
      message: `The project folder ${projectDir} has ${taken.length === 1 ? "a folder or file" : "folders or files"} at the worktree path of ${list}.`,
      hint: `Move ${list} out of the project folder, then run the command again.`,
      details: { path: projectDir, folders: taken },
    });
  }
  const defaults = await checkWorktreeRepos(
    ctx,
    signal,
    codebase,
    branch,
    repos,
  );
  const choices = await chooseBranches(
    ctx,
    signal,
    codebase,
    branch,
    repos,
    defaults,
  );

  for (const repo of repos) {
    await addWorktreeStep(ctx, tx, {
      repo,
      repoDir: join(codebase, repo),
      path: join(projectDir, repo),
      branch,
      choice: choices.get(repo) as BranchChoice,
    });
  }
  const all = new Set([...project.repos, ...repos]);
  const configured = ctx.config.repos
    .map(({ name }) => name)
    .filter((name) => all.has(name));
  const known = new Set(configured);
  const newRepos = [
    ...configured,
    ...project.repos.filter((name) => !known.has(name)),
  ];
  const list = repos.join(", ");
  const file = join(projectDir, ".crossrepo", "project.yaml");
  await writeProjectRecordStep(
    fs,
    tx,
    projectDir,
    { branch, codebase, repos: newRepos, created: project.created },
    `Remove ${list} from \`repos:\` in ${file} by hand.`,
  );
  const agents = join(projectDir, "AGENTS.md");
  await writeAgentsStep(
    fs,
    tx,
    agents,
    projectAgentsText(fs, {
      projectDir,
      codebaseDir: codebase,
      branch,
      repos: newRepos,
      configRepos: ctx.config.repos,
    }),
    `Remove the ${list} lines from the \`## Codebase\` and \`## Repos\` sections of AGENTS.md by hand.`,
  );

  return {
    projectDir,
    branch,
    repos: repos.map((repo) => {
      const { source, message } = choices.get(repo) as BranchChoice;
      return { repo, status: "ok", message, source };
    }),
  };
}
