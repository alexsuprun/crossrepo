import { join } from "node:path";
import {
  type ConfigRepo,
  renderCodebaseConfig,
} from "../domain/codebase-config.ts";
import type { Ctx, Tx } from "../domain/ctx.ts";
import type { Block, Text } from "../domain/report.ts";
import { XrError } from "../errors/index.ts";
import { writeCodebaseSection } from "./agents-md.ts";

type Problem = {
  repo: string;
  problem: string;
  fix: Text;
};

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
  const problems: Problem[] = [];
  for (const name of names) {
    const repoDir = join(dir, name);
    const remote = await ctx.git.originUrl(repoDir);
    const defaultBranch =
      remote === undefined ? undefined : await ctx.git.originHead(repoDir);
    if (remote !== undefined && defaultBranch !== undefined) {
      repos.push({ name, remote, defaultBranch });
      ctx.out.emit({
        type: "repo",
        repo: name,
        status: "ok",
        message: defaultBranch,
      });
      continue;
    }
    const problem: Problem =
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
    problems.push(problem);
    ctx.out.emit({
      type: "repo",
      repo: name,
      status: "failed",
      message: problem.problem,
    });
  }
  if (problems.length) {
    const list = problems.map((problem) => problem.repo).join(", ");
    const table: Block = {
      type: "table",
      key: "repos",
      items: problems,
    };
    throw new XrError({
      code: "repos-not-ready",
      message:
        problems.length === 1
          ? `1 repo is not ready: ${list}.`
          : `${problems.length} repos are not ready: ${list}.`,
      hint: "Run the fix for each repo, then run `xr codebase init` again.",
      blocks: [table],
    });
  }
  return repos;
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
