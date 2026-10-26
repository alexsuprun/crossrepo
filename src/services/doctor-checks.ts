import { basename, join } from "node:path";
import { repoHeadings } from "../domain/agents-md.ts";
import { repoKeys } from "../domain/codebase-config.ts";
import type { ConfigRepoView, ConfigView, Ctx } from "../domain/ctx.ts";
import type { Block, CheckItem, Report } from "../domain/report.ts";
import { GitError, XrError } from "../errors/index.ts";
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

/**
 * The end of every doctor: the Report with one `checks` block, or, when an item
 * is `error`, `checks-failed` with that block next to `error`.
 */
export function finishChecks(items: CheckItem[]): Report {
  const block: Block = { type: "checks", items };
  const failed = items.filter((item) => item.status === "error").length;
  if (failed) {
    throw new XrError({
      code: "checks-failed",
      message: `${failed} ${failed === 1 ? "check" : "checks"} failed`,
      report: [block],
    });
  }
  return { blocks: [block] };
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
