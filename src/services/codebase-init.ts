import { join } from "node:path";
import {
  type ConfigRepo,
  renderCodebaseConfig,
} from "../domain/codebase-config.ts";
import type { Ctx, GitCallOptions, Tx } from "../domain/ctx.ts";
import type { Block, Text } from "../domain/report.ts";
import { XrError } from "../errors/index.ts";
import { writeCodebaseSection } from "./agents-md.ts";

/** One row of the `repos` table of a `repos-not-ready` error. */
export interface RepoProblem {
  repo: string;
  problem: string;
  fix: Text;
}

/**
 * Finds the repos directly in `dir` (folders with a `.git` entry, sorted by name)
 * and reads `origin` and `origin/HEAD` of each. Emits one `repo` event per repo.
 * Throws `repos-not-ready` listing every repo that misses one of them.
 */
export async function checkRepos(
  ctx: Pick<Ctx, "fs" | "git" | "out">,
  dir: string,
): Promise<ConfigRepo[]> {
  await ctx.git.version();
  const names = ctx.fs
    .listDirs(dir)
    .filter((name) => ctx.fs.exists(join(dir, name, ".git")));
  const repos: ConfigRepo[] = [];
  const problems: RepoProblem[] = [];
  for (const name of names) {
    const result = await checkRepo(ctx, name, join(dir, name));
    if ("problem" in result) problems.push(result);
    else repos.push(result);
  }
  if (problems.length) {
    throw reposNotReady(
      problems,
      "Run the fix for each repo, then run `xr codebase init` again.",
    );
  }
  return repos;
}

/**
 * Reads `origin` and `origin/HEAD` of the repo at `repoDir` and emits one `repo`
 * event. Gives the config entry, or the problem when one of them is missing.
 */
export async function checkRepo(
  ctx: Pick<Ctx, "git" | "out">,
  name: string,
  repoDir: string,
  options?: GitCallOptions,
): Promise<ConfigRepo | RepoProblem> {
  const remote = await ctx.git.originUrl(repoDir, options);
  const defaultBranch =
    remote === undefined
      ? undefined
      : await ctx.git.originHead(repoDir, options);
  if (remote !== undefined && defaultBranch !== undefined) {
    ctx.out.emit({
      type: "repo",
      repo: name,
      status: "ok",
      message: defaultBranch,
    });
    return { name, remote, defaultBranch };
  }
  const problem: RepoProblem =
    remote === undefined
      ? {
          repo: name,
          problem: "no origin remote",
          fix: { code: `git -C "${repoDir}" remote add origin <url>` },
        }
      : {
          repo: name,
          problem: "no origin/HEAD",
          fix: { code: `git -C "${repoDir}" remote set-head origin --auto` },
        };
  ctx.out.emit({
    type: "repo",
    repo: name,
    status: "failed",
    message: problem.problem,
  });
  return problem;
}

/** The `repos-not-ready` error with one `repos` table row per problem. */
export function reposNotReady(
  problems: readonly RepoProblem[],
  hint: string,
): XrError {
  const list = problems.map((problem) => problem.repo).join(", ");
  const table: Block = {
    type: "table",
    key: "repos",
    items: problems.map((problem) => ({ ...problem })),
  };
  return new XrError({
    code: "repos-not-ready",
    message:
      problems.length === 1
        ? `1 repo is not ready: ${list}.`
        : `${problems.length} repos are not ready: ${list}.`,
    hint,
    blocks: [table],
  });
}

/**
 * The 3 steps of `codebase init`: make `.crossrepo/`, write its `config.yaml`,
 * and write the `## Codebase` section of `AGENTS.md`. Each step has its undo.
 */
export async function writeCodebaseFiles(
  ctx: Pick<Ctx, "fs">,
  tx: Tx,
  dir: string,
  repos: readonly ConfigRepo[],
): Promise<void> {
  const { fs } = ctx;
  const folder = join(dir, ".crossrepo");
  const config = join(folder, "config.yaml");
  const agents = join(dir, "AGENTS.md");
  await tx.step(
    "Create .crossrepo/",
    () => fs.mkdir(folder),
    () => fs.remove(folder),
    { what: ".crossrepo folder", path: folder, command: `rm -r "${folder}"` },
  );
  await tx.step(
    "Write .crossrepo/config.yaml",
    () => fs.writeText(config, renderCodebaseConfig(repos)),
    // The `.crossrepo/` undo removes the file with its folder.
    () => {},
    { what: "config file", path: config, command: `rm "${config}"` },
  );
  const isNew = fs.readText(agents) === undefined;
  await tx.step(
    "Write AGENTS.md",
    () => writeCodebaseSection(fs, dir, repos),
    (old) =>
      old === undefined ? fs.remove(agents) : fs.writeText(agents, old),
    {
      what: "AGENTS.md",
      path: agents,
      command: isNew
        ? `rm "${agents}"`
        : "Remove the `## Codebase` section from AGENTS.md by hand.",
    },
  );
}
