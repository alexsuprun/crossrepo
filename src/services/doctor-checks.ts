import { basename, join, resolve } from "node:path";
import { findSections, repoHeadings } from "../domain/agents-md.ts";
import { repoKeys } from "../domain/codebase-config.ts";
import type { ConfigRepoView, ConfigView, Ctx } from "../domain/ctx.ts";
import {
  type ProjectRecord,
  parseProjectRecord,
} from "../domain/project-record.ts";
import type { Block, CheckItem, Report } from "../domain/report.ts";
import { GitError, XrError } from "../errors/index.ts";
import { driftFolders } from "./project-remove.ts";
import { codebaseConfigPath } from "./repo-add.ts";
import { repoFolders } from "./repos.ts";

/** What the checks read. Every call reads only; no check writes a file or a git ref. */
export type CheckCtx = Pick<Ctx, "fs" | "git" | "config">;

/** The ids of the codebase checks, in the order they run. */
export const CODEBASE_CHECK_IDS = [
  "unknown-config-key",
  "reserved-var-name",
  "repo-not-in-config",
  "repo-folder-missing",
  "agents-heading-no-repo",
  "agents-repo-no-heading",
  "stale-worktree",
] as const;

type CodebaseCheckId = (typeof CODEBASE_CHECK_IDS)[number];

/** The ids of the project checks, in the order they run after the codebase checks. */
export const PROJECT_CHECK_IDS = [
  "project-record",
  "codebase-path",
  "worktree-missing",
  "worktree-not-registered",
  "worktree-branch",
  "project-drift",
  "project-agents-md",
] as const;

type ProjectCheckId = (typeof PROJECT_CHECK_IDS)[number];

/** A problem of one check, without the id. */
type Problem = Omit<CheckItem, "id">;

const VARS_PREFIX = "project.vars.";

/** A `project.vars` name that would clash with the built-in hook vars: `CROSSREPO_` in any case. */
export function isReservedVarName(name: string): boolean {
  return name.toUpperCase().startsWith("CROSSREPO_");
}

/** Each reserved `project.vars` name with the config file that sets the value in use. */
export function reservedVars(
  config: Pick<ConfigView, "vars" | "entries">,
): { name: string; file: string }[] {
  return Object.keys(config.vars)
    .filter(isReservedVarName)
    .map((name) => {
      const source = config.entries.find(
        (entry) => entry.key === `${VARS_PREFIX}${name}`,
      )?.source;
      return {
        name,
        file: source?.kind === "file" ? source.path : "the config",
      };
    });
}

/** Throws `reserved-var-name` when `project.vars` has a reserved name. */
export function rejectReservedVars(
  config: Pick<ConfigView, "vars" | "entries">,
): void {
  const bad = reservedVars(config);
  if (!bad.length) return;
  throw new XrError({
    code: "reserved-var-name",
    message: `Reserved var names in \`project.vars\`: ${bad
      .map(({ name, file }) => `\`${name}\` (${file})`)
      .join(", ")}.`,
    hint: "xr codebase doctor",
  });
}

/** Runs the seven codebase checks in order. Reads only. */
export async function codebaseChecks(
  ctx: CheckCtx,
  codebase: string,
): Promise<CheckItem[]> {
  const repos = configuredRepos(ctx, codebase);
  const agents = agentsProblems(ctx, codebase, repos);
  const results: Record<CodebaseCheckId, Problem[]> = {
    "unknown-config-key": unknownKeyProblems(ctx.config),
    "reserved-var-name": reservedVars(ctx.config).map(({ name, file }) => ({
      status: "error",
      message: name,
      fix: `rename \`${name}\` in \`${file}\``,
    })),
    "repo-not-in-config": await notInConfigProblems(ctx, codebase, repos),
    "repo-folder-missing": folderMissingProblems(ctx, codebase, repos),
    "agents-heading-no-repo": agents.headings,
    "agents-repo-no-heading": agents.repos,
    "stale-worktree": await staleWorktreeProblems(ctx, codebase, repos),
  };
  return CODEBASE_CHECK_IDS.flatMap((id) => itemsOf(id, results[id]));
}

const RECORD_UNREADABLE = "project record cannot be read";
const CODEBASE_NOT_FOUND = "codebase not found";

/**
 * Every item of a project doctor: the codebase checks, then the project
 * checks. `codebase` is the codebase discovery found, if any. Checks that need
 * data a failed check could not give are `skipped`. Reads only.
 */
export async function projectDoctorChecks(
  ctx: CheckCtx,
  project: string,
  codebase: string | undefined,
): Promise<CheckItem[]> {
  const recordFile = join(project, ".crossrepo", "project.yaml");
  const text = ctx.fs.readText(recordFile);
  const record =
    text === undefined
      ? { problem: "it cannot be read" }
      : parseProjectRecord(text, { requireBranch: true });
  if ("problem" in record) {
    return [
      ...(codebase === undefined
        ? skippedItems(CODEBASE_CHECK_IDS, RECORD_UNREADABLE)
        : await codebaseChecks(ctx, codebase)),
      {
        id: "project-record",
        status: "error",
        message: `${recordFile}: ${record.problem}`,
        fix: "correct `.crossrepo/project.yaml`: keys branch, codebase, repos, created",
      },
      ...skippedItems(PROJECT_CHECK_IDS.slice(1), RECORD_UNREADABLE),
    ];
  }
  const recordCodebase = resolve(project, record.codebase);
  const found = isCodebase(ctx, recordCodebase);
  const worktrees = found
    ? await worktreeProblems(ctx, project, recordCodebase, record)
    : undefined;
  const results: Record<ProjectCheckId, Problem[] | "skipped"> = {
    "project-record": [],
    "codebase-path": found
      ? []
      : [
          codebasePathProblem(
            project,
            record,
            recordCodebase,
            await repairNeeds(ctx),
          ),
        ],
    "worktree-missing": worktreeMissingProblems(ctx, project, record),
    "worktree-not-registered": worktrees?.notRegistered ?? "skipped",
    "worktree-branch": worktrees?.branch ?? "skipped",
    "project-drift": driftFolders(ctx.fs, project, record.repos).map(
      (folder) => ({
        status: "error",
        message: folder,
        fix: `move \`${folder}\` out of the project folder`,
      }),
    ),
    "project-agents-md": found
      ? projectAgentsProblems(ctx, project, recordCodebase, record)
      : "skipped",
  };
  return [
    ...(found
      ? await codebaseChecks(ctx, codebase ?? recordCodebase)
      : skippedItems(CODEBASE_CHECK_IDS, CODEBASE_NOT_FOUND)),
    ...PROJECT_CHECK_IDS.flatMap((id) => {
      const problems = results[id];
      return problems === "skipped"
        ? skippedItems([id], CODEBASE_NOT_FOUND)
        : itemsOf(id, problems);
    }),
  ];
}

/**
 * The end of every doctor: the Report with `leading` and one `checks` block,
 * or, when an item is `error`, `checks-failed` with those blocks next to `error`.
 */
export function finishChecks(
  items: CheckItem[],
  leading: readonly Block[] = [],
): Report {
  const blocks: Block[] = [...leading, { type: "checks", items }];
  const failed = items.filter((item) => item.status === "error").length;
  if (failed) {
    throw new XrError({
      code: "checks-failed",
      message: `${failed} ${failed === 1 ? "check" : "checks"} failed`,
      report: blocks,
    });
  }
  return { blocks };
}

function skippedItems(ids: readonly string[], message: string): CheckItem[] {
  return ids.map((id) => ({ id, status: "skipped", message }));
}

function isCodebase(ctx: CheckCtx, dir: string): boolean {
  return ["config.yaml", "config.yml"].some((name) =>
    ctx.fs.exists(join(dir, ".crossrepo", name)),
  );
}

/**
 * The line that starts a `git worktree repair` fix on git older than 2.29,
 * which has no `worktree repair`; empty on newer git, or when git cannot say
 * its version.
 */
async function repairNeeds(ctx: CheckCtx): Promise<string[]> {
  let version: string;
  try {
    version = await ctx.git.version();
  } catch {
    return [];
  }
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 2 || (major === 2 && minor >= 29)
    ? []
    : [`needs git 2.29 or newer (you have ${version}):`];
}

/** `<codebase>` stays as written: the right folder is not known. */
function codebasePathProblem(
  project: string,
  record: ProjectRecord,
  resolved: string,
  needs: string[],
): Problem {
  return {
    status: "error",
    message: { path: resolved },
    fix: [
      ...needs,
      "set `codebase` in `.crossrepo/project.yaml` to the codebase folder, then run:",
      ...record.repos.map(
        (repo) =>
          `git -C "<codebase>/${repo}" worktree repair "${join(project, repo)}"`,
      ),
    ].join("\n"),
  };
}

function worktreeMissingProblems(
  ctx: CheckCtx,
  project: string,
  record: ProjectRecord,
): Problem[] {
  const name = basename(project);
  return record.repos
    .filter((repo) => !ctx.fs.exists(join(project, repo)))
    .map((repo) => ({
      status: "error",
      message: repo,
      fix: `xr project repo remove ${repo} --project ${name}\nxr project repo add ${repo} --project ${name}`,
    }));
}

/**
 * `worktree-not-registered` and `worktree-branch` together: each existing
 * worktree folder must be a worktree of its codebase repo (by `dev` and
 * `ino`), readable by git, and on the record branch.
 */
async function worktreeProblems(
  ctx: CheckCtx,
  project: string,
  codebase: string,
  record: ProjectRecord,
): Promise<{ notRegistered: Problem[]; branch: Problem[] }> {
  const withGit = new Set(repoFolders(ctx.fs, codebase));
  const notRegistered: Problem[] = [];
  const branch: Problem[] = [];
  const want = record.branch ?? "";
  for (const repo of record.repos) {
    const path = join(project, repo);
    const self = ctx.fs.stat(path);
    if (!self) continue;
    const dir = join(codebase, repo);
    const listed = withGit.has(repo)
      ? await orUndefined(ctx.git.worktreeList(dir))
      : undefined;
    const readable = await readBranch(ctx, path);
    if (listed !== undefined) {
      const registered = listed.some(({ path: entry }) => {
        const other = ctx.fs.stat(entry);
        return other?.dev === self.dev && other.ino === self.ino;
      });
      if (!registered || !readable.ok) {
        const repair = `git -C "${dir}" worktree repair "${path}"`;
        const needs = await repairNeeds(ctx);
        notRegistered.push({
          status: "error",
          message: { path },
          fix: needs.length ? [...needs, repair].join("\n") : { code: repair },
        });
      }
    }
    if (!readable.ok || readable.branch === want) continue;
    branch.push({
      status: "warn",
      message: `${path}: ${
        readable.branch === undefined
          ? "detached HEAD"
          : `on branch \`${readable.branch}\`, not \`${want}\``
      }; \`xr project sync\` refuses this worktree`,
      fix: { code: `git -C "${path}" switch ${want}` },
    });
  }
  return { notRegistered, branch };
}

/** The current branch of a worktree, `undefined` for a detached HEAD; not `ok` when git cannot read it. */
async function readBranch(
  ctx: CheckCtx,
  path: string,
): Promise<{ ok: true; branch: string | undefined } | { ok: false }> {
  try {
    return { ok: true, branch: await ctx.git.currentBranch(path) };
  } catch (error) {
    if (error instanceof GitError) return { ok: false };
    throw error;
  }
}

/** `project-agents-md`, with the heading rules of `repoHeadings`. */
function projectAgentsProblems(
  ctx: CheckCtx,
  project: string,
  codebase: string,
  record: ProjectRecord,
): Problem[] {
  const text = ctx.fs.readText(join(project, "AGENTS.md"));
  if (text === undefined) {
    return [
      {
        status: "warn",
        fix: "add `AGENTS.md` with a `## Codebase` and a `## Repos` section",
      },
    ];
  }
  const problems: Problem[] = [];
  if (findSections(text).codebase === undefined) {
    problems.push({
      status: "warn",
      message: "## Codebase",
      fix: "add a `## Codebase` section to `AGENTS.md`",
    });
  }
  const titles = repoHeadings(text) ?? [];
  const repoNames = new Set(record.repos.map((repo) => repo.toLowerCase()));
  for (const title of titles) {
    if (repoNames.has(title.toLowerCase())) continue;
    problems.push({
      status: "warn",
      message: title,
      fix: `remove "### ${title}" from "## Repos" in AGENTS.md`,
    });
  }
  const own = new Set(titles.map((title) => title.toLowerCase()));
  const base = ctx.fs.readText(join(codebase, "AGENTS.md"));
  const inCodebase = new Set(
    (base === undefined ? [] : (repoHeadings(base) ?? [])).map((title) =>
      title.toLowerCase(),
    ),
  );
  for (const repo of record.repos) {
    const key = repo.toLowerCase();
    if (!inCodebase.has(key) || own.has(key)) continue;
    problems.push({
      status: "warn",
      message: repo,
      fix: `add "### ${repo}" under "## Repos" in AGENTS.md (copy it from the codebase AGENTS.md)`,
    });
  }
  return problems;
}

/**
 * The merged repos, then the keys of the codebase file with a null value, which
 * the merged config drops (`web:` with nothing under it).
 */
function configuredRepos(ctx: CheckCtx, codebase: string): ConfigRepoView[] {
  const merged = ctx.config.repos;
  const names = new Set(merged.map((repo) => repo.name));
  const text = ctx.fs.readText(codebaseConfigPath(ctx.fs, codebase)) ?? "";
  return [
    ...merged,
    ...repoKeys(text)
      .filter((name) => !names.has(name))
      .map((name) => ({ name })),
  ];
}

function itemsOf(id: string, problems: Problem[]): CheckItem[] {
  return problems.length
    ? problems.map((problem) => ({ id, ...problem }))
    : [{ id, status: "ok" }];
}

function unknownKeyProblems(config: ConfigView): Problem[] {
  return config.unknownKeys.map(({ key, files, suggestion }) => ({
    status: "warn",
    message: `${key} in ${files.join(", ")}`,
    fix: suggestion ? `rename it to \`${suggestion}\`` : "remove it",
  }));
}

async function notInConfigProblems(
  ctx: CheckCtx,
  codebase: string,
  repos: readonly ConfigRepoView[],
): Promise<Problem[]> {
  const names = new Set(repos.map((repo) => repo.name));
  const file = basename(codebaseConfigPath(ctx.fs, codebase));
  const problems: Problem[] = [];
  for (const folder of repoFolders(ctx.fs, codebase)) {
    if (names.has(folder)) continue;
    // A `.git` that git cannot read gives no `remote:` line.
    const origin = await orUndefined(ctx.git.originUrl(join(codebase, folder)));
    problems.push({
      status: "warn",
      message: folder,
      fix: [
        `add to .crossrepo/${file}:`,
        "  repos:",
        `    ${folder}:`,
        ...(origin === undefined ? [] : [`      remote: ${origin}`]),
      ].join("\n"),
    });
  }
  return problems;
}

function folderMissingProblems(
  ctx: CheckCtx,
  codebase: string,
  repos: readonly ConfigRepoView[],
): Problem[] {
  return repos
    .filter((repo) => !ctx.fs.exists(join(codebase, repo.name)))
    .map(({ name, remote }) => ({
      status: "error",
      message: name,
      fix:
        remote === undefined
          ? `clone the repo into \`${name}\``
          : { code: `git clone ${remote} ${name}` },
    }));
}

/** Checks 5 and 6 together, since both read the `## Repos` headings. */
function agentsProblems(
  ctx: CheckCtx,
  codebase: string,
  configured: readonly ConfigRepoView[],
): { headings: Problem[]; repos: Problem[] } {
  const repos = configured.map((repo) => repo.name);
  const text = ctx.fs.readText(join(codebase, "AGENTS.md"));
  const headings = text === undefined ? undefined : repoHeadings(text);
  if (headings === undefined) {
    return {
      headings: [],
      repos: repos.length
        ? [
            {
              status: "warn",
              fix: "add a `## Repos` section with one `### <repo>` per repo",
            },
          ]
        : [],
    };
  }
  const repoNames = new Set(repos.map((name) => name.toLowerCase()));
  const titles = new Set(headings.map((title) => title.toLowerCase()));
  return {
    headings: headings
      .filter((title) => !repoNames.has(title.toLowerCase()))
      .map((title) => ({
        status: "warn",
        message: title,
        fix: "rename it to a repo name, or remove it",
      })),
    repos: repos
      .filter((name) => !titles.has(name.toLowerCase()))
      .map((name) => ({
        status: "warn",
        message: name,
        fix: `add "### ${name}" under "## Repos" in AGENTS.md`,
      })),
  };
}

async function staleWorktreeProblems(
  ctx: CheckCtx,
  codebase: string,
  repos: readonly ConfigRepoView[],
): Promise<Problem[]> {
  const withGit = new Set(repoFolders(ctx.fs, codebase));
  const problems: Problem[] = [];
  for (const { name } of repos) {
    if (!withGit.has(name)) continue;
    const dir = join(codebase, name);
    // A `.git` that git cannot read is skipped.
    const worktrees = await orUndefined(ctx.git.worktreeList(dir));
    for (const { path } of worktrees ?? []) {
      if (ctx.fs.exists(path)) continue;
      problems.push({
        status: "warn",
        message: { path },
        fix: { code: `git -C "${dir}" worktree prune` },
      });
    }
  }
  return problems;
}

/** The value, or `undefined` when git fails; any other error is thrown. */
async function orUndefined<T>(call: Promise<T>): Promise<T | undefined> {
  try {
    return await call;
  } catch (error) {
    if (error instanceof GitError) return undefined;
    throw error;
  }
}
