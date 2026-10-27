import { afterEach, beforeEach, spyOn } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import * as gitAdapter from "../../src/adapters/git/index.ts";
import { main } from "../../src/cli/index.ts";
import { findSections } from "../../src/domain/agents-md.ts";
import { git, makeRepos } from "./git.ts";
import { type FakeInterrupts, fakeInterrupts } from "./interrupts.ts";
import { type Isolation, isolate, writeFile } from "./isolate.ts";

/** The codebase `AGENTS.md`: user text around a `## Repos` section with one part per repo. */
export const CODEBASE_AGENTS = [
  "# Team",
  "",
  "Be kind.",
  "",
  "## Repos",
  "",
  "### api",
  "",
  "API notes.",
  "",
  "### web",
  "",
  "Web notes.",
  "",
  "### docs",
  "",
  "Docs notes.",
  "",
  "## Footer",
  "",
  "Mine.",
  "",
].join("\n");

export interface RunOptions {
  cwd?: string;
  tty?: boolean;
}

/**
 * A codebase `shop` with the repos `api`, `web` and `docs` on disk (local bare
 * origins), and the project `feat--login` made by `xr project create feat/login
 * api`. Registers its own `beforeEach` and `afterEach`.
 */
export function useProjectRepoEnv() {
  const env = {
    iso: undefined as unknown as Isolation,
    codebase: "",
    projects: "",
    login: "",
    configFile: "",
    lockFile: "",
    remotes: {} as Record<string, string | undefined>,
    spies: [] as { mockRestore(): void }[],
    interrupts: undefined as unknown as FakeInterrupts,
    chdirs: [] as string[],
  };

  function writeConfig() {
    const entry = (name: string, description: string) => [
      `  ${name}:`,
      `    remote: ${JSON.stringify(env.remotes[name])}`,
      "    default-branch: main",
      `    description: ${JSON.stringify(description)}`,
    ];
    writeFile(
      env.configFile,
      [
        "repos:",
        ...entry("api", "Public REST API"),
        ...entry("web", "Frontend"),
        ...entry("docs", "Docs site"),
        "",
      ].join("\n"),
    );
  }

  async function run(
    argv: string[],
    { cwd = env.codebase, tty = false }: RunOptions = {},
  ) {
    let stdout = "";
    let stderr = "";
    const testEnv = { ...process.env };
    delete testEnv.FORCE_COLOR;
    delete testEnv.NO_COLOR;
    const code = await main({
      version: "1.2.3",
      argv,
      env: testEnv,
      isTTY: { stdin: tty, stdout: tty, stderr: false },
      cwd,
      home: env.iso.home,
      interrupts: env.interrupts,
      // The test runner must never change its own folder.
      chdir: (dir) => {
        env.chdirs.push(dir);
      },
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      now: () => new Date("2026-10-26T10:00:00Z"),
    });
    return { code, stdout, stderr };
  }

  async function json(argv: string[], options?: RunOptions) {
    const result = await run(["--json", ...argv], options);
    return { ...result, data: JSON.parse(result.stdout) };
  }

  /** Makes `createGit` give a wrapped adapter for the rest of the test. */
  function fakeGit(wrap: (git: gitAdapter.Git) => gitAdapter.Git) {
    const real = gitAdapter.createGit;
    env.spies.push(
      spyOn(gitAdapter, "createGit").mockImplementation((options) =>
        wrap(real(options)),
      ),
    );
  }

  function branches(repo: string): string[] {
    return git(join(env.codebase, repo), "branch", "--format=%(refname:short)")
      .split("\n")
      .filter(Boolean)
      .sort();
  }

  function worktreePaths(repo: string): string[] {
    return (
      git(join(env.codebase, repo), "worktree", "list", "--porcelain")
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        // git writes `C:/x` on Windows.
        .map((line) => resolve(line.slice("worktree ".length)))
    );
  }

  function record(project = env.login): string {
    return readFileSync(join(project, ".crossrepo", "project.yaml"), "utf8");
  }

  /** The `repos:` list of the project record. */
  function recordRepos(project = env.login): string[] {
    return record(project)
      .split("\n")
      .filter((line) => line.startsWith("  - "))
      .map((line) => line.slice(4));
  }

  function configText(): string {
    return readFileSync(env.configFile, "utf8");
  }

  function agents(project = env.login): string {
    return readFileSync(join(project, "AGENTS.md"), "utf8");
  }

  /** What a refused or undone command must leave as it was. */
  function state() {
    const of = (repo: string) =>
      existsSync(join(env.codebase, repo))
        ? { branches: branches(repo), worktrees: worktreePaths(repo) }
        : null;
    return {
      projects: readdirSync(env.projects).sort(),
      login: existsSync(env.login) ? readdirSync(env.login).sort() : null,
      record: record(),
      agents: agents(),
      api: of("api"),
      web: of("web"),
      docs: of("docs"),
    };
  }

  beforeEach(async () => {
    env.iso = isolate();
    env.codebase = join(env.iso.root, "shop");
    env.projects = join(env.codebase, ".projects");
    mkdirSync(env.codebase);
    env.configFile = join(env.codebase, ".crossrepo", "config.yaml");
    env.lockFile = join(env.codebase, ".crossrepo", "xr.lock");
    env.spies = [];
    env.interrupts = fakeInterrupts();
    env.chdirs = [];
    env.remotes = makeRepos(env.codebase, { api: {}, web: {}, docs: {} });
    writeConfig();
    writeFile(join(env.codebase, "AGENTS.md"), CODEBASE_AGENTS);
    const made = await run(["project", "create", "feat/login", "api"]);
    if (made.code !== 0) throw new Error(made.stderr);
    env.login = join(env.projects, "feat--login");
  });

  afterEach(() => {
    for (const spy of env.spies) spy.mockRestore();
    env.iso.restore();
  });

  return {
    env,
    run,
    json,
    fakeGit,
    branches,
    worktreePaths,
    record,
    recordRepos,
    agents,
    configText,
    state,
  };
}

/** The text of an `AGENTS.md` without its `## Codebase` and `## Repos` sections. */
export function outsideSections(text: string): string {
  const { codebase, repos } = findSections(text);
  const ranges = [codebase, repos]
    .filter((range) => range !== undefined)
    .sort((a, b) => b.start - a.start);
  let rest = text;
  for (const { start, end } of ranges) {
    rest = rest.slice(0, start) + rest.slice(end);
  }
  return rest;
}

/** Every file under `dir` with its text, skipping the inside of `.git` folders. */
export function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    if (/(^|[\\/])\.git([\\/]|$)/.test(name)) continue;
    const path = join(dir, name);
    files[name] = statSync(path).isDirectory()
      ? "<dir>"
      : readFileSync(path, "utf8");
  }
  return files;
}

/** The refs and worktree list of the repo `repo` in `codebase`. */
export function gitRefs(codebase: string, repo: string) {
  const dir = join(codebase, repo);
  return {
    refs: git(dir, "for-each-ref"),
    worktrees: git(dir, "worktree", "list", "--porcelain"),
  };
}
