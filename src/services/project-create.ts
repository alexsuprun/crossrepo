import { basename, join } from "node:path";
import type { Ctx, Tx } from "../domain/ctx.ts";
import { LIST_HINT } from "../domain/hints.ts";
import {
  badBranchChars,
  branchSlug,
  hookEnv,
  hookVars,
  isoSeconds,
} from "../domain/project.ts";
import type { RepoItem } from "../domain/report.ts";
import { XrError } from "../errors/index.ts";
import { projectAgentsText, writeAgentsStep } from "./agents-md.ts";
import { reposNotReady } from "./codebase-init.ts";
import { runHookSteps } from "./hooks.ts";
import { makeProjectFolderStep, writeProjectRecordStep } from "./projects.ts";
import { type RepoState, repoState } from "./repos.ts";
import {
  addWorktreeStep,
  type BranchChoice,
  chooseBranch,
} from "./worktrees.ts";

/** What `xr project create` makes: the branch and the repos in config order. */
export interface CreatePlan {
  branch: string;
  repos: string[];
}

/** What `xr project create` made. */
export interface CreatedProject {
  projectDir: string;
  branch: string;
  repos: RepoItem[];
}

const USAGE_HINT = "Run `xr project create --help` for usage.";
/** The command that puts the missing repos on disk. */
export const CLONE_HINT = "xr codebase clone";

/**
 * The argument checks of `xr project create`, then the repo picker when no repo
 * and no `--all` is given. Runs before the transaction, so no lock is held
 * while the user picks. Changes nothing.
 */
export async function createPlan(
  ctx: Pick<Ctx, "fs" | "config" | "prompt">,
  codebase: string,
  args: readonly (string | undefined)[],
  { all }: { all: boolean },
): Promise<CreatePlan> {
  const [branch, ...names] = args as string[];
  if (!branch) throw usage("Give the branch of the project.");
  const bad = badBranchChars(branch);
  if (bad.length) {
    throw usage(
      `The branch \`${branch}\` has ${bad.map((char) => `\`${char}\``).join(", ")}, which a folder name cannot have on Windows.`,
      'Use a branch name with none of < > : | " ? *.',
    );
  }
  if (all && names.length) {
    throw usage("Give repo names or `--all`, not both.");
  }
  const states = ctx.config.repos.map((repo) =>
    repoState(ctx.fs, codebase, repo),
  );
  if (!all && names.length === 0) {
    const picked = await ctx.prompt.pickMany({
      argument: "repos",
      message: "Pick the repos of the project",
      choices: states.filter((state) => state.present).map(({ name }) => name),
      missing: "Give the repos of the project, or `--all`.",
      listLabel: "Repos",
      hint: "xr project create <branch> <repo>... | --all",
      empty: {
        message: "There is no repo on disk to put in a project.",
        hint: CLONE_HINT,
      },
    });
    return { branch, repos: picked };
  }
  checkKnownRepos(states, names);
  const wanted = new Set(names);
  const chosen = all ? states : states.filter(({ name }) => wanted.has(name));
  if (chosen.length === 0) {
    throw new XrError({
      code: "missing-argument",
      message: "There is no repo on disk to put in a project.",
      hint: CLONE_HINT,
      details: { argument: "repos", choices: [] },
    });
  }
  checkReposOnDisk(chosen);
  return { branch, repos: chosen.map(({ name }) => name) };
}

/** `repo-not-found` for the first of `names` that is not a repo of the merged config. */
export function checkKnownRepos(
  states: readonly RepoState[],
  names: readonly string[],
): void {
  const known = new Set(states.map(({ name }) => name));
  const unknown = names.find((name) => !known.has(name));
  if (unknown !== undefined) {
    throw new XrError({
      code: "repo-not-found",
      message: `The codebase has no repo named \`${unknown}\`.`,
      hint: `See the repos with \`${LIST_HINT}\`.`,
    });
  }
}

/** `repos-not-ready` with the clone hint when one of `states` is not on disk. */
export function checkReposOnDisk(states: readonly RepoState[]): void {
  const missing = states.filter((state) => !state.present);
  if (missing.length) {
    throw reposNotReady(
      missing.map(({ name }) => ({
        repo: name,
        problem: "not on disk",
        fix: { code: CLONE_HINT },
      })),
      `Run \`${CLONE_HINT}\`, then run the command again.`,
    );
  }
}

/**
 * The checks and steps of `xr project create`, run inside a transaction that
 * holds the lock. The checks change nothing: the project folder is free, each
 * repo fetches, has a default branch and does not have the branch checked
 * out, and `sh` is found when `post-create` is set. Then the steps make the
 * folder, the worktrees, the record, `AGENTS.md`, and run `post-create`.
 */
export async function createProject(
  ctx: Pick<
    Ctx,
    "fs" | "git" | "out" | "config" | "hooks" | "env" | "platform" | "now"
  >,
  tx: Tx,
  codebase: string,
  { branch, repos }: CreatePlan,
): Promise<CreatedProject> {
  const { fs } = ctx;
  const slug = branchSlug(branch);
  const projectDir = join(ctx.config.projectsDir.resolved, slug);
  const repoDir = (repo: string) => join(codebase, repo);
  const { signal } = tx;

  if (fs.exists(projectDir)) {
    throw new XrError({
      code: "project-exists",
      message: `The project folder ${projectDir} already exists.`,
      hint: "Use another branch name, or move or remove that folder, then run the command again.",
      details: { path: projectDir },
    });
  }
  const defaults = await checkWorktreeRepos(
    ctx,
    signal,
    codebase,
    branch,
    repos,
  );
  const postCreate = ctx.config.postCreate;
  if (postCreate.length) ctx.hooks.findSh();
  const choices = await chooseBranches(
    ctx,
    signal,
    codebase,
    branch,
    repos,
    defaults,
  );

  await makeProjectFolderStep(fs, tx, projectDir);
  for (const repo of repos) {
    await addWorktreeStep(ctx, tx, {
      repo,
      repoDir: repoDir(repo),
      path: join(projectDir, repo),
      branch,
      choice: choices.get(repo) as BranchChoice,
    });
  }
  await writeProjectRecordStep(fs, tx, projectDir, {
    branch,
    codebase,
    repos,
    created: isoSeconds(ctx.now()),
  });
  const agents = join(projectDir, "AGENTS.md");
  await writeAgentsStep(
    fs,
    tx,
    agents,
    projectAgentsText(fs, {
      projectDir,
      codebaseDir: codebase,
      branch,
      repos,
      configRepos: ctx.config.repos,
    }),
    `rm "${agents}"`,
  );

  const env = hookEnv(
    ctx.env,
    ctx.config.vars,
    hookVars({
      codebasePath: codebase,
      codebaseName: ctx.config.name ?? basename(codebase),
      projectPath: projectDir,
      projectName: slug,
      branch,
      repos,
      hook: "post-create",
    }),
    ctx.platform,
  );
  await runHookSteps(ctx, tx, "post-create", postCreate, {
    cwd: projectDir,
    env,
    cleanup: (command) => ({
      what: "post-create hook",
      path: projectDir,
      command: `Undo by hand what \`${command}\` made outside the project folder, if anything.`,
    }),
  });

  return {
    projectDir,
    branch,
    repos: repos.map((repo) => {
      const { source, message } = choices.get(repo) as BranchChoice;
      return { repo, status: "ok", message, source };
    }),
  };
}

/**
 * The checks of a new worktree of `branch` in each repo, in order: `git fetch
 * origin`, the default branch, and `branch` not checked out in another place
 * (`branch-in-use`). Changes nothing. Gives the default branch of each repo.
 */
export async function checkWorktreeRepos(
  ctx: Pick<Ctx, "fs" | "git" | "out" | "config">,
  signal: AbortSignal,
  codebase: string,
  branch: string,
  repos: readonly string[],
): Promise<Map<string, string>> {
  const { fs, git } = ctx;
  const repoDir = (repo: string) => join(codebase, repo);
  for (const repo of repos) {
    await check(ctx, `Fetch ${repo}`, () =>
      git.fetch(repoDir(repo), { signal }),
    );
  }
  const defaults = new Map<string, string>();
  for (const repo of repos) {
    defaults.set(repo, await defaultBranch(ctx, repo, repoDir(repo), signal));
  }
  for (const repo of repos) {
    const user = (await git.worktreeList(repoDir(repo), { signal })).find(
      (worktree) => worktree.branch === branch,
    );
    if (user) {
      throw new XrError({
        code: "branch-in-use",
        message: `The branch \`${branch}\` of \`${repo}\` is checked out in ${user.path}.`,
        // A folder deleted by hand still has its worktree entry until a prune.
        hint: fs.exists(user.path)
          ? "Switch that folder to another branch, or use another branch name, then run the command again."
          : `Run \`git -C "${repoDir(repo)}" worktree prune\`, then run the command again.`,
        details: { repo, path: user.path },
      });
    }
  }
  return defaults;
}

/**
 * The branch choice of each repo (see `chooseBranch`). A new branch needs
 * `origin/<default branch>`, else `no-default-branch`. Reads only.
 */
export async function chooseBranches(
  ctx: Pick<Ctx, "git">,
  signal: AbortSignal,
  codebase: string,
  branch: string,
  repos: readonly string[],
  defaults: ReadonlyMap<string, string>,
): Promise<Map<string, BranchChoice>> {
  const { git } = ctx;
  const choices = new Map<string, BranchChoice>();
  for (const repo of repos) {
    const dir = join(codebase, repo);
    const start = defaults.get(repo) as string;
    const choice = await chooseBranch(git, dir, branch, start, { signal });
    if (
      choice.source === "new" &&
      !(await git.remoteBranchExists(dir, start, { signal }))
    ) {
      throw new XrError({
        code: "no-default-branch",
        message: `\`${repo}\` has no \`origin/${start}\`, the default branch to start \`${branch}\` from.`,
        hint: `Fix \`default-branch\` of \`${repo}\` in the config, or run \`git -C "${dir}" remote set-head origin --auto\`, then run the command again.`,
        details: { repo },
      });
    }
    choices.set(repo, choice);
  }
  return choices;
}

/** A check that shows one step line and changes nothing. */
async function check(
  ctx: Pick<Ctx, "out">,
  label: string,
  run: () => Promise<void>,
): Promise<void> {
  ctx.out.emit({ type: "step-start", text: label });
  try {
    await run();
  } catch (error) {
    ctx.out.emit({ type: "step-end", text: label, ok: false });
    throw error;
  }
  ctx.out.emit({ type: "step-end", text: label, ok: true });
}

/** Config `default-branch`, else `origin/HEAD`, else `no-default-branch`. */
async function defaultBranch(
  ctx: Pick<Ctx, "config" | "git">,
  repo: string,
  dir: string,
  signal: AbortSignal,
): Promise<string> {
  const configured = ctx.config.repos.find(
    (entry) => entry.name === repo,
  )?.defaultBranch;
  const found = configured ?? (await ctx.git.originHead(dir, { signal }));
  if (found) return found;
  throw new XrError({
    code: "no-default-branch",
    message: `\`${repo}\` has no default branch: the config has no \`default-branch\` for it, and \`origin/HEAD\` is not set.`,
    hint: `Run \`git -C "${dir}" remote set-head origin --auto\`, or set \`default-branch\` of \`${repo}\` in the config, then run the command again.`,
    details: { repo },
  });
}

function usage(message: string, hint = USAGE_HINT): XrError {
  return new XrError({ code: "usage", message, hint });
}
