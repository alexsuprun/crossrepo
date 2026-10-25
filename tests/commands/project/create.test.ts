import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as gitAdapter from "../../../src/adapters/git/index.ts";
import * as hooksAdapter from "../../../src/adapters/hooks/index.ts";
import { main } from "../../../src/cli/index.ts";
import { renderCodebaseConfig } from "../../../src/domain/codebase-config.ts";
import { withFault } from "../../helpers/faults.ts";
import { git, makeRepos } from "../../helpers/git.ts";
import {
  type FakeInterrupts,
  fakeInterrupts,
} from "../../helpers/interrupts.ts";
import { type Isolation, isolate, writeFile } from "../../helpers/isolate.ts";
import { fakeKeys, fakePickMany } from "../../helpers/prompt.ts";

let iso: Isolation;
let codebase: string;
let projects: string;
let configFile: string;
let localConfig: string;
let lockFile: string;
let remotes: Record<string, string | undefined>;
let spies: { mockRestore(): void }[];
let interrupts: FakeInterrupts;

const CREATE = ["project", "create"];
const NOW = new Date("2026-10-20T14:03:12.640Z");
const AGENTS = "# Team\n\nBe kind.\n";

beforeEach(() => {
  iso = isolate();
  codebase = join(iso.root, "shop");
  projects = join(codebase, ".projects");
  mkdirSync(codebase);
  configFile = join(codebase, ".crossrepo", "config.yaml");
  localConfig = join(codebase, ".crossrepo", "config.local.yaml");
  lockFile = join(codebase, ".crossrepo", "xr.lock");
  spies = [];
  interrupts = fakeInterrupts();
  remotes = makeRepos(codebase, { api: {}, web: {} });
  writeConfig();
  writeFile(join(codebase, "AGENTS.md"), AGENTS);
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  iso.restore();
});

/** The codebase config with api and web, plus `extra` YAML at the end. */
function writeConfig(extra = "") {
  writeFile(
    configFile,
    renderCodebaseConfig([
      { name: "api", remote: remotes.api as string, defaultBranch: "main" },
      { name: "web", remote: remotes.web as string, defaultBranch: "main" },
    ]) + extra,
  );
}

function testEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  return env;
}

interface RunOptions {
  cwd?: string;
  tty?: boolean;
}

async function run(
  argv: string[],
  { cwd = codebase, tty = false }: RunOptions = {},
) {
  let stdout = "";
  let stderr = "";
  const code = await main({
    version: "1.2.3",
    argv,
    env: testEnv(),
    isTTY: { stdin: tty, stdout: tty, stderr: false },
    cwd,
    home: iso.home,
    interrupts,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    now: () => NOW,
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
  spies.push(
    spyOn(gitAdapter, "createGit").mockImplementation((options) =>
      wrap(real(options)),
    ),
  );
}

function branches(repo: string): string[] {
  return git(join(codebase, repo), "branch", "--format=%(refname:short)")
    .split("\n")
    .filter(Boolean)
    .sort();
}

function worktreePaths(repo: string): string[] {
  return (
    git(join(codebase, repo), "worktree", "list", "--porcelain")
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      // git writes `C:/x` on Windows.
      .map((line) => resolve(line.slice("worktree ".length)))
  );
}

function upstreamOf(dir: string, branch: string): string | undefined {
  try {
    return git(dir, "rev-parse", "--abbrev-ref", `${branch}@{upstream}`).trim();
  } catch {
    return undefined;
  }
}

/** What a failed create must leave as it was. */
function state() {
  return {
    projects: existsSync(projects) ? readdirSync(projects).sort() : null,
    api: { branches: branches("api"), worktrees: worktreePaths("api") },
    web: { branches: branches("web"), worktrees: worktreePaths("web") },
    agents: readFileSync(join(codebase, "AGENTS.md"), "utf8"),
  };
}

/** Puts `post-create` lines (and optional vars) in the codebase config. */
function postCreate(lines: string[], vars = "") {
  writeConfig(
    [
      "project:",
      "  post-create:",
      ...lines.map((line) => `    - ${JSON.stringify(line)}`),
      vars,
      "",
    ].join("\n"),
  );
}

describe("xr project create: success", () => {
  test("--all --json: one JSON object, the folder layout, the record and the worktrees", async () => {
    const result = await json([...CREATE, "feat/x", "--all"]);
    const project = join(projects, "feat--x");
    expect(result.code).toBe(0);
    expect(result.data).toEqual({
      ok: true,
      warnings: [],
      project,
      branch: "feat/x",
      repos: [
        {
          repo: "api",
          status: "ok",
          message: "new branch from origin/main",
          source: "new",
        },
        {
          repo: "web",
          status: "ok",
          message: "new branch from origin/main",
          source: "new",
        },
      ],
    });
    expect(readdirSync(project).sort()).toEqual([
      ".crossrepo",
      "AGENTS.md",
      "api",
      "web",
    ]);
    expect(
      readFileSync(join(project, ".crossrepo", "project.yaml"), "utf8"),
    ).toBe(
      `branch: feat/x\ncodebase: ${codebase}\nrepos:\n  - api\n  - web\ncreated: 2026-10-20T14:03:12Z\n`,
    );
    expect(worktreePaths("api")).toContain(join(project, "api"));
    expect(git(join(project, "api"), "branch", "--show-current").trim()).toBe(
      "feat/x",
    );
    expect(upstreamOf(join(project, "api"), "feat/x")).toBeUndefined();
    const agents = readFileSync(join(project, "AGENTS.md"), "utf8");
    expect(agents).toStartWith("# Team\n\nBe kind.\n");
    expect(agents).toContain("feat/x");
    expect(existsSync(join(project, "CLAUDE.md"))).toBe(false);
    expect(existsSync(lockFile)).toBe(false);
    // Nothing is committed.
    expect(git(join(project, "api"), "status", "--porcelain")).toBe("");
  });

  test("each branch source: local, tracking, new", async () => {
    git(join(codebase, "api"), "branch", "feat/x");
    git(join(codebase, "web"), "push", "--quiet", "origin", "main:feat/x");
    const result = await json([...CREATE, "feat/x", "api", "web"]);
    expect(result.code).toBe(0);
    expect(result.data.repos).toEqual([
      { repo: "api", status: "ok", message: "local branch", source: "local" },
      {
        repo: "web",
        status: "ok",
        message: "tracking origin/feat/x",
        source: "tracking",
      },
    ]);
    const web = join(projects, "feat--x", "web");
    expect(upstreamOf(web, "feat/x")).toBe("origin/feat/x");
  });

  test("named repos are used in config order, once each", async () => {
    const result = await json([...CREATE, "feat/x", "web", "api", "web"]);
    expect(result.code).toBe(0);
    expect(result.data.repos.map((r: { repo: string }) => r.repo)).toEqual([
      "api",
      "web",
    ]);
  });

  test("text mode: the path relative to the codebase, the branch and one line per repo", async () => {
    const result = await run([...CREATE, "feat/login", "api"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      [
        join(".projects", "feat--login"),
        "",
        "feat/login",
        "",
        "✓ api: new branch from origin/main",
        "",
      ].join("\n"),
    );
    expect(result.stderr).toContain("Fetch api");
    expect(result.stderr).toContain("Make project folder");
    expect(result.stderr).toContain("Add worktree api");
    expect(result.stderr).toContain("Write project record");
    expect(result.stderr).toContain("Write AGENTS.md");
  });

  test("a missing projects-dir is made with its parents", async () => {
    writeFile(localConfig, "projects-dir: ../work/deep/projects\n");
    const result = await json([...CREATE, "feat/x", "api"]);
    expect(result.code).toBe(0);
    expect(
      existsSync(join(iso.root, "work", "deep", "projects", "feat--x", "api")),
    ).toBe(true);
  });

  test("the picker: the picked repos make the project", async () => {
    const requests = fakePickMany(spies, ["web"]);
    // `docs` is in the config but not on disk, so the picker leaves it out.
    writeConfig("  docs:\n    remote: nowhere\n    default-branch: main\n");
    const result = await run([...CREATE, "feat/x"], { tty: true });
    expect(result.code).toBe(0);
    expect(requests[0]?.choices).toEqual(["api", "web"]);
    expect(readdirSync(join(projects, "feat--x")).sort()).toEqual([
      ".crossrepo",
      "AGENTS.md",
      "web",
    ]);
  });

  test("the picker with the real adapter: Space and Enter pick api", async () => {
    fakeKeys(spies, [" ", "\r"]);
    const result = await run([...CREATE, "feat/x"], { tty: true });
    expect(result.code).toBe(0);
    expect(existsSync(join(projects, "feat--x", "api"))).toBe(true);
    expect(existsSync(join(projects, "feat--x", "web"))).toBe(false);
  });
});

describe("xr project create: argument checks change nothing", () => {
  test("no branch: usage, exit 2", async () => {
    const before = state();
    const result = await json(CREATE);
    expect(result.code).toBe(2);
    expect(result.data.error.code).toBe("usage");
    expect(state()).toEqual(before);
  });

  for (const char of ["<", ">", ":", "|", '"', "?", "*"]) {
    test(`a branch with ${char}: usage, exit 2`, async () => {
      const before = state();
      const result = await json([...CREATE, `feat${char}x`, "api"]);
      expect(result.code).toBe(2);
      expect(result.data.error.code).toBe("usage");
      expect(result.data.error.message).toContain(char);
      expect(state()).toEqual(before);
    });
  }

  test("--all and names: usage, exit 2", async () => {
    const before = state();
    const result = await json([...CREATE, "feat/x", "--all", "api"]);
    expect(result.code).toBe(2);
    expect(result.data.error.code).toBe("usage");
    expect(state()).toEqual(before);
  });

  test("an unknown repo: repo-not-found with the list hint", async () => {
    const before = state();
    const result = await json([...CREATE, "feat/x", "api", "nope"]);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("repo-not-found");
    expect(result.data.error.hint).toContain("xr codebase repo list");
    expect(state()).toEqual(before);
  });

  for (const how of [["docs"], ["--all"]]) {
    test(`a repo not on disk (${how.join(" ")}): repos-not-ready with the clone hint`, async () => {
      writeConfig("  docs:\n    remote: nowhere\n    default-branch: main\n");
      const before = state();
      const result = await json([...CREATE, "feat/x", ...how]);
      expect(result.code).toBe(1);
      expect(result.data.error.code).toBe("repos-not-ready");
      expect(result.data.error.hint).toContain("xr codebase clone");
      expect(result.data.error.details.repos).toEqual([
        { repo: "docs", problem: "not on disk", fix: "xr codebase clone" },
      ]);
      expect(state()).toEqual(before);
    });
  }

  test("--all with no repos in the config: missing-argument with no choices", async () => {
    writeFile(configFile, renderCodebaseConfig([]));
    const result = await json([...CREATE, "feat/x", "--all"]);
    expect(result.code).toBe(2);
    expect(result.data.error.code).toBe("missing-argument");
    expect(result.data.error.details).toEqual({
      argument: "repos",
      choices: [],
    });
    expect(existsSync(projects)).toBe(false);
  });

  test("no names, not interactive: missing-argument with the choices", async () => {
    const result = await json([...CREATE, "feat/x"]);
    expect(result.code).toBe(2);
    expect(result.data.error.code).toBe("missing-argument");
    expect(result.data.error.details).toEqual({
      argument: "repos",
      choices: ["api", "web"],
    });
    expect(existsSync(projects)).toBe(false);
  });

  for (const tty of [true, false]) {
    test(`no repo on disk, tty ${tty}: the empty message and the clone hint`, async () => {
      writeFile(configFile, renderCodebaseConfig([]));
      fakeKeys(spies, []);
      const result = await run([...CREATE, "feat/x"], { tty });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(
        "There is no repo on disk to put in a project.",
      );
      expect(result.stderr).toContain("xr codebase clone");
    });
  }

  test("Escape in the picker: interrupted, exit 130", async () => {
    fakeKeys(spies, ["\x1b"]);
    const result = await run([...CREATE, "feat/x"], { tty: true });
    expect(result.code).toBe(130);
    expect(existsSync(projects)).toBe(false);
  });

  test("in a project folder: not-a-codebase", async () => {
    expect((await json([...CREATE, "feat/x", "api"])).code).toBe(0);
    const result = await json([...CREATE, "feat/y", "api"], {
      cwd: join(projects, "feat--x"),
    });
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("not-a-codebase");
  });
});

describe("xr project create: transaction checks change nothing", () => {
  test("an existing project folder: project-exists with the path", async () => {
    mkdirSync(join(projects, "feat--x"), { recursive: true });
    const before = state();
    const result = await json([...CREATE, "feat/x", "api"]);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("project-exists");
    expect(result.data.error.message).toContain(join(projects, "feat--x"));
    expect(result.data.error.details).toEqual({
      path: join(projects, "feat--x"),
    });
    expect(state()).toEqual(before);
  });

  test("a slug clash: feat--x and feat/x are one folder", async () => {
    expect((await json([...CREATE, "feat--x", "api"])).code).toBe(0);
    const before = state();
    const result = await json([...CREATE, "feat/x", "web"]);
    expect(result.data.error.code).toBe("project-exists");
    expect(state()).toEqual(before);
  });

  test("a failed fetch: git-failed", async () => {
    git(
      join(codebase, "web"),
      "remote",
      "set-url",
      "origin",
      join(iso.root, "gone.git"),
    );
    const before = state();
    const result = await json([...CREATE, "feat/x", "--all"]);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("git-failed");
    expect(state()).toEqual(before);
  });

  test("no default branch: no-default-branch with the set-head hint", async () => {
    writeFile(
      configFile,
      `repos:\n  api:\n    remote: ${JSON.stringify(remotes.api)}\n`,
    );
    git(join(codebase, "api"), "remote", "set-head", "origin", "--delete");
    // git 2.48 and newer makes origin/HEAD again on fetch unless told not to.
    git(
      join(codebase, "api"),
      "config",
      "remote.origin.followRemoteHEAD",
      "never",
    );
    const before = state();
    const result = await json([...CREATE, "feat/x", "api"]);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("no-default-branch");
    expect(result.data.error.hint).toContain(
      `git -C "${join(codebase, "api")}" remote set-head origin --auto`,
    );
    expect(state()).toEqual(before);
  });

  test("origin/HEAD gives the default branch when the config has none", async () => {
    writeFile(
      configFile,
      `repos:\n  api:\n    remote: ${JSON.stringify(remotes.api)}\n`,
    );
    const result = await json([...CREATE, "feat/x", "api"]);
    expect(result.code).toBe(0);
    expect(result.data.repos[0].message).toBe("new branch from origin/main");
  });

  test("the branch checked out in the codebase repo: branch-in-use", async () => {
    git(join(codebase, "web"), "checkout", "--quiet", "-b", "feat/x");
    const before = state();
    const result = await json([...CREATE, "feat/x", "--all"]);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("branch-in-use");
    expect(result.data.error.details).toEqual({
      repo: "web",
      path: join(codebase, "web"),
    });
    expect(state()).toEqual(before);
  });

  test("the branch checked out in another worktree: branch-in-use", async () => {
    const other = join(iso.root, "elsewhere");
    git(
      join(codebase, "api"),
      "worktree",
      "add",
      "--quiet",
      "-b",
      "feat/x",
      other,
    );
    const before = state();
    const result = await json([...CREATE, "feat/x", "api"]);
    expect(result.data.error.code).toBe("branch-in-use");
    expect(result.data.error.details.path).toBe(other);
    expect(state()).toEqual(before);
  });

  test("a config default-branch that origin does not have: no-default-branch", async () => {
    writeFile(
      configFile,
      `repos:\n  api:\n    remote: ${JSON.stringify(remotes.api)}\n    default-branch: trunk\n`,
    );
    const before = state();
    const result = await json([...CREATE, "feat/x", "api"]);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("no-default-branch");
    expect(result.data.error.message).toContain("origin/trunk");
    expect(state()).toEqual(before);
  });

  test("the branch in a worktree whose folder is gone: branch-in-use with the prune hint", async () => {
    const other = join(iso.root, "gone");
    git(
      join(codebase, "api"),
      "worktree",
      "add",
      "--quiet",
      "-b",
      "feat/x",
      other,
    );
    rmSync(other, { recursive: true });
    const before = state();
    const result = await json([...CREATE, "feat/x", "api"]);
    expect(result.data.error.code).toBe("branch-in-use");
    expect(result.data.error.hint).toBe(
      `Run \`git -C "${join(codebase, "api")}" worktree prune\`, then run the command again.`,
    );
    expect(state()).toEqual(before);
  });

  test("Ctrl-C during the checks: git stops, nothing changes, exit 130", async () => {
    let signalled = false;
    fakeGit((g) => ({
      ...g,
      async fetch(dir, options) {
        interrupts.fire();
        signalled = options?.signal?.aborted === true;
        return g.fetch(dir, options);
      },
    }));
    const before = state();
    const result = await json([...CREATE, "feat/x", "--all"]);
    expect(result.code).toBe(130);
    expect(result.data.error.code).toBe("interrupted");
    expect(signalled).toBe(true);
    expect(state()).toEqual(before);
    expect(existsSync(lockFile)).toBe(false);
  });

  test("no sh with post-create set: sh-not-found", async () => {
    postCreate(["true"]);
    const real = hooksAdapter.createHooks;
    spies.push(
      spyOn(hooksAdapter, "createHooks").mockImplementation((options) =>
        real({ ...options, platform: "win32", exists: () => false }),
      ),
    );
    const before = state();
    const result = await json([...CREATE, "feat/x", "api"]);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("sh-not-found");
    expect(result.data.error.hint).toContain("Git for Windows");
    expect(state()).toEqual(before);
  });
});

describe("xr project create: undo", () => {
  test("a failed worktree add: full undo, nothing left", async () => {
    fakeGit((g) => withFault(g, "worktreeAdd", 2));
    const before = state();
    const result = await json([...CREATE, "feat/x", "--all"]);
    expect(result.code).toBe(1);
    expect(result.data.error.message).toContain("fault in worktreeAdd");
    expect(state()).toEqual(before);
  });

  test("a failed worktree add removes the projects-dir folders this run made", async () => {
    writeFile(localConfig, "projects-dir: ../work/deep/projects\n");
    mkdirSync(join(iso.root, "work"));
    fakeGit((g) => withFault(g, "worktreeAdd", 2));
    const result = await json([...CREATE, "feat/x", "--all"]);
    expect(result.code).toBe(1);
    expect(existsSync(join(iso.root, "work"))).toBe(true);
    expect(existsSync(join(iso.root, "work", "deep"))).toBe(false);
  });

  test("a failed post-create: hook-failed with the last 20 lines, full undo", async () => {
    git(join(codebase, "api"), "branch", "feat/x");
    git(join(codebase, "web"), "push", "--quiet", "origin", "main:feat/x");
    postCreate([
      "touch made-by-hook",
      "i=0; while [ $i -lt 25 ]; do i=$((i+1)); echo line $i; done; exit 3",
      "echo never > never.txt",
    ]);
    const before = state();
    const result = await json([...CREATE, "feat/x", "--all"]);
    expect(result.code).toBe(1);
    const { error } = result.data;
    expect(error.code).toBe("hook-failed");
    expect(error.message).toContain("exit code 3");
    expect(error.details.exitCode).toBe(3);
    const lines = error.details.hookOutput.lines.split("\n");
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe("line 6");
    expect(lines[19]).toBe("line 25");
    expect(existsSync(join(projects, "feat--x"))).toBe(false);
    // The local branch and the new tracking branch stay; nothing else is left.
    expect(state()).toEqual({
      ...before,
      web: { ...before.web, branches: ["feat/x", "main"] },
    });
    expect(result.stderr).toContain("line 25");
  });

  test("a hook that runs over the time limit: hook-failed, timed out after 10 minutes", async () => {
    const real = hooksAdapter.createHooks;
    spies.push(
      spyOn(hooksAdapter, "createHooks").mockImplementation((options) =>
        real({ ...options, timeoutMs: 300 }),
      ),
    );
    postCreate(["sleep 30"]);
    const before = state();
    const started = Date.now();
    const result = await json([...CREATE, "feat/x", "api"]);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.data.error.code).toBe("hook-failed");
    expect(result.data.error.message).toContain("timed out after 10 minutes");
    expect(state()).toEqual(before);
  });

  test("Ctrl-C while a hook runs: the hook stops, full undo, exit 130", async () => {
    postCreate(["touch started; sleep 30"]);
    const before = state();
    const started = Date.now();
    const pending = json([...CREATE, "feat/x", "--all"]);
    const marker = join(projects, "feat--x", "started");
    for (let i = 0; i < 200 && !existsSync(marker); i += 1) await sleep(50);
    interrupts.fire();
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.code).toBe(130);
    expect(result.data.error.code).toBe("interrupted");
    expect(state()).toEqual(before);
    expect(existsSync(lockFile)).toBe(false);
  });

  test("a failed undo still runs the other undos and lists the leftovers", async () => {
    fakeGit((g) => withFault(g, "worktreeRemove", 1));
    postCreate(["false"]);
    const result = await json([...CREATE, "feat/x", "--all"]);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("hook-failed");
    const path = join(projects, "feat--x", "web");
    const repo = join(codebase, "web");
    expect(result.data.error.details.leftovers).toEqual([
      {
        what: "worktree of web",
        path,
        command: `git -C "${repo}" worktree remove --force "${path}" && git -C "${repo}" branch -D "feat/x"`,
      },
    ]);
    // The api undo still ran.
    expect(branches("api")).toEqual(["main"]);
  });
});

describe("xr project create: post-create", () => {
  test("the hook gets the branch, its output goes to stderr also with --json", async () => {
    postCreate([
      'echo "$CROSSREPO_PROJECT_BRANCH" > branch.txt',
      "echo hello-from-hook; echo err-from-hook >&2",
    ]);
    const result = await json([...CREATE, "feat/x", "api"]);
    expect(result.code).toBe(0);
    const project = join(projects, "feat--x");
    expect(readFileSync(join(project, "branch.txt"), "utf8").trim()).toBe(
      "feat/x",
    );
    expect(result.stderr).toContain("hello-from-hook");
    expect(result.stderr).toContain("err-from-hook");
    expect(result.stderr).toContain(
      'post-create: echo "$CROSSREPO_PROJECT_BRANCH" > branch.txt',
    );
    expect(result.stdout).not.toContain("hello-from-hook");
    expect(result.data.ok).toBe(true);
  });

  test("the 7 built-in vars and project.vars; the built-ins win", async () => {
    postCreate(
      [
        'for v in "$CROSSREPO_CODEBASE_PATH" "$CROSSREPO_CODEBASE_NAME" "$CROSSREPO_PROJECT_PATH" "$CROSSREPO_PROJECT_NAME" "$CROSSREPO_PROJECT_BRANCH" "$CROSSREPO_HOOK" "$PORT" "$DEBUG"; do printf "%s\\n" "$v"; done > vars.txt; printf "%s" "$CROSSREPO_PROJECT_REPOS" > repos.txt',
      ],
      "  vars:\n    PORT: 5432\n    DEBUG: true\n    CROSSREPO_HOOK: mine",
    );
    const result = await json([...CREATE, "feat/x", "--all"]);
    expect(result.code).toBe(0);
    const project = join(projects, "feat--x");
    expect(
      readFileSync(join(project, "vars.txt"), "utf8").trim().split(/\r?\n/),
    ).toEqual([
      codebase,
      "shop",
      project,
      "feat--x",
      "feat/x",
      "post-create",
      "5432",
      "true",
    ]);
    expect(readFileSync(join(project, "repos.txt"), "utf8")).toBe("api\nweb");
  });

  test("CROSSREPO_CODEBASE_NAME is the config name when set", async () => {
    postCreate(['echo "$CROSSREPO_CODEBASE_NAME" > name.txt']);
    writeFile(
      join(codebase, ".crossrepo", "config.local.yaml"),
      "name: Shop\n",
    );
    const result = await json([...CREATE, "feat/x", "api"]);
    expect(result.code).toBe(0);
    expect(
      readFileSync(join(projects, "feat--x", "name.txt"), "utf8").trim(),
    ).toBe("Shop");
  });
});
