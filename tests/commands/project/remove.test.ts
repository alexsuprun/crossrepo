import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as gitAdapter from "../../../src/adapters/git/index.ts";
import * as hooksAdapter from "../../../src/adapters/hooks/index.ts";
import * as promptAdapter from "../../../src/adapters/prompt/index.ts";
import { main } from "../../../src/cli/index.ts";
import { renderCodebaseConfig } from "../../../src/domain/codebase-config.ts";
import { GitError } from "../../../src/errors/index.ts";
import { afterCall, withFault } from "../../helpers/faults.ts";
import { git, makeRepos } from "../../helpers/git.ts";
import {
  type FakeInterrupts,
  fakeInterrupts,
} from "../../helpers/interrupts.ts";
import { type Isolation, isolate, writeFile } from "../../helpers/isolate.ts";
import { fakeKeys, fakePick } from "../../helpers/prompt.ts";

let iso: Isolation;
let codebase: string;
let projects: string;
let configFile: string;
let lockFile: string;
let login: string;
let remotes: Record<string, string | undefined>;
let spies: { mockRestore(): void }[];
let interrupts: FakeInterrupts;
let chdirs: string[];

const REMOVE = ["project", "remove"];
const ESCAPE = "\x1b";

beforeEach(async () => {
  iso = isolate();
  codebase = join(iso.root, "shop");
  projects = join(codebase, ".projects");
  mkdirSync(codebase);
  configFile = join(codebase, ".crossrepo", "config.yaml");
  lockFile = join(codebase, ".crossrepo", "xr.lock");
  spies = [];
  interrupts = fakeInterrupts();
  chdirs = [];
  remotes = makeRepos(codebase, { api: {}, web: {} });
  writeConfig();
  writeFile(join(codebase, "AGENTS.md"), "# Team\n");
  const made = await run(["project", "create", "feat/login", "--all"]);
  if (made.code !== 0) throw new Error(made.stderr);
  login = join(projects, "feat--login");
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

/** Puts `pre-remove` lines in the codebase config. */
function preRemove(lines: string[]) {
  hooks({ "pre-remove": lines });
}

/** Puts hook lists, such as `{ "post-remove": [...] }`, and optional vars YAML in the codebase config. */
function hooks(lists: Record<string, string[]>, vars = "") {
  writeConfig(
    [
      "project:",
      ...Object.entries(lists).flatMap(([name, lines]) => [
        `  ${name}:`,
        ...lines.map((line) => `    - ${JSON.stringify(line)}`),
      ]),
      vars,
      "",
    ].join("\n"),
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
    // The test runner must never change its own folder.
    chdir: (dir) => {
      chdirs.push(dir);
    },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
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

/** What a refused remove must leave as it was. */
function state() {
  return {
    projects: existsSync(projects) ? readdirSync(projects).sort() : null,
    login: existsSync(login) ? readdirSync(login).sort() : null,
    api: { branches: branches("api"), worktrees: worktreePaths("api") },
    web: { branches: branches("web"), worktrees: worktreePaths("web") },
  };
}

/** The state after a remove of `feat--login` that kept the branches. */
function removedState() {
  return {
    projects: [],
    login: null,
    api: {
      branches: ["feat/login", "main"],
      worktrees: [join(codebase, "api")],
    },
    web: {
      branches: ["feat/login", "main"],
      worktrees: [join(codebase, "web")],
    },
  };
}

const kept = (repo: string) => ({
  repo,
  status: "ok",
  message: "worktree removed, branch kept",
  branchDeleted: false,
});

describe("xr project remove: success", () => {
  test("by folder name, --json: worktrees and folder gone, branches kept", async () => {
    const result = await json([...REMOVE, "feat--login"]);
    expect(result.code).toBe(0);
    expect(result.data).toEqual({
      ok: true,
      warnings: [],
      project: login,
      branch: "feat/login",
      repos: [kept("api"), kept("web")],
    });
    expect(state()).toEqual(removedState());
    expect(existsSync(lockFile)).toBe(false);
    expect(chdirs).toEqual([]);
  });

  test("by branch: the same as by folder name", async () => {
    const result = await json([...REMOVE, "feat/login"]);
    expect(result.code).toBe(0);
    expect(result.data.project).toBe(login);
    expect(state()).toEqual(removedState());
  });

  test("text mode: the step lines in delete order, then the Report", async () => {
    const result = await run([...REMOVE, "feat--login", "--delete-branch"]);
    expect(result.code).toBe(0);
    const order = [
      "✓ Remove worktree api",
      "✓ Remove worktree web",
      "✓ Delete branch api",
      "✓ Delete branch web",
      "✓ Remove project folder",
    ].map((line) => result.stderr.indexOf(line));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(result.stdout).toBe(
      [
        join(".projects", "feat--login"),
        "",
        "feat/login",
        "",
        "✓ api: worktree removed, branch deleted",
        "✓ web: worktree removed, branch deleted",
        "",
      ].join("\n"),
    );
  });

  test("an ignored file only: the remove goes on", async () => {
    appendFileSync(join(codebase, "api", ".git", "info", "exclude"), "*.log\n");
    writeFile(join(login, "api", "debug.log"), "x\n");
    const result = await json([...REMOVE, "feat--login"]);
    expect(result.code).toBe(0);
    expect(state()).toEqual(removedState());
  });

  test("unpushed commits do not count as lost work", async () => {
    git(join(login, "api"), "commit", "--quiet", "--allow-empty", "-m", "x");
    const result = await json([...REMOVE, "feat--login"]);
    expect(result.code).toBe(0);
  });

  test("a folder whose name starts with a dot is not drift and goes with the project", async () => {
    mkdirSync(join(login, ".idea"));
    writeFile(join(login, ".idea", "workspace.xml"), "x\n");
    const result = await json([...REMOVE, "feat--login"]);
    expect(result.code).toBe(0);
    expect(existsSync(login)).toBe(false);
  });

  test("files next to the worktrees, such as AGENTS.md, are not drift", async () => {
    writeFile(join(login, "notes.txt"), "mine\n");
    const result = await json([...REMOVE, "feat--login"]);
    expect(result.code).toBe(0);
    expect(existsSync(login)).toBe(false);
  });

  test("--force with changes: the worktree goes with its changes", async () => {
    writeFile(join(login, "api", "new.txt"), "x\n");
    const result = await json([...REMOVE, "feat--login", "--force"]);
    expect(result.code).toBe(0);
    expect(state()).toEqual(removedState());
  });

  test("a worktree on another branch is accepted", async () => {
    git(join(login, "api"), "switch", "--quiet", "-c", "other");
    const result = await json([...REMOVE, "feat--login"]);
    expect(result.code).toBe(0);
    expect(result.data.repos).toEqual([kept("api"), kept("web")]);
    expect(worktreePaths("api")).toEqual([join(codebase, "api")]);
  });

  test("a missing worktree folder: git worktree prune, with the warning on the step line", async () => {
    rmSync(join(login, "api"), { recursive: true });
    const result = await json([...REMOVE, "feat--login"]);
    expect(result.code).toBe(0);
    expect(result.data.repos).toEqual([
      {
        repo: "api",
        status: "ok",
        message: "worktree folder missing, git entry pruned",
        branchDeleted: false,
      },
      kept("web"),
    ]);
    expect(result.stderr).toContain(
      "✓ Remove worktree api (worktree folder missing)",
    );
    expect(state()).toEqual(removedState());
  });

  test("a broken record of another project is a warning, not a stop", async () => {
    writeFile(join(projects, "broken", ".crossrepo", "project.yaml"), "x: [\n");
    const result = await json([...REMOVE, "feat--login"]);
    expect(result.code).toBe(0);
    expect(result.data.warnings.map((w: { code: string }) => w.code)).toEqual([
      "invalid-project-record",
    ]);
    expect(existsSync(login)).toBe(false);
  });
});

describe("xr project remove --delete-branch", () => {
  test("merged branches: deleted with git branch -d", async () => {
    const result = await json([...REMOVE, "feat--login", "--delete-branch"]);
    expect(result.code).toBe(0);
    expect(result.data.repos).toEqual(
      ["api", "web"].map((repo) => ({
        repo,
        status: "ok",
        message: "worktree removed, branch deleted",
        branchDeleted: true,
      })),
    );
    expect(branches("api")).toEqual(["main"]);
    expect(branches("web")).toEqual(["main"]);
  });

  test("an unmerged branch: kept, a branch-not-merged warning with a branch -D hint, exit 0", async () => {
    git(join(login, "api"), "commit", "--quiet", "--allow-empty", "-m", "new");
    const result = await json([...REMOVE, "feat--login", "--delete-branch"]);
    expect(result.code).toBe(0);
    const hint = `git -C "${join(codebase, "api")}" branch -D feat/login`;
    expect(result.data.repos).toEqual([
      {
        repo: "api",
        status: "ok",
        message: "worktree removed, branch kept: not merged",
        hint,
        branchDeleted: false,
      },
      {
        repo: "web",
        status: "ok",
        message: "worktree removed, branch deleted",
        branchDeleted: true,
      },
    ]);
    expect(result.data.warnings).toHaveLength(1);
    expect(result.data.warnings[0].code).toBe("branch-not-merged");
    expect(result.data.warnings[0].hint).toContain(hint);
    expect(branches("api")).toEqual(["feat/login", "main"]);
    expect(branches("web")).toEqual(["main"]);
    expect(existsSync(login)).toBe(false);
  });

  test("a branch deleted by hand: branch already gone, exit 0", async () => {
    git(join(login, "api"), "switch", "--quiet", "-c", "other");
    git(join(codebase, "api"), "branch", "-D", "feat/login");
    const result = await json([...REMOVE, "feat--login", "--delete-branch"]);
    expect(result.code).toBe(0);
    expect(result.data.repos[0]).toEqual({
      repo: "api",
      status: "ok",
      message: "worktree removed, branch already gone",
      branchDeleted: false,
    });
    expect(result.data.warnings).toEqual([]);
  });

  test("--force never deletes an unmerged branch", async () => {
    git(join(login, "api"), "commit", "--quiet", "--allow-empty", "-m", "new");
    const result = await json([
      ...REMOVE,
      "feat--login",
      "--delete-branch",
      "--force",
    ]);
    expect(result.code).toBe(0);
    expect(branches("api")).toEqual(["feat/login", "main"]);
  });

  test("a missing worktree folder still gets its branch step", async () => {
    rmSync(join(login, "web"), { recursive: true });
    const result = await json([...REMOVE, "feat--login", "--delete-branch"]);
    expect(result.code).toBe(0);
    expect(result.data.repos[1]).toEqual({
      repo: "web",
      status: "ok",
      message: "worktree folder missing, git entry pruned, branch deleted",
      branchDeleted: true,
    });
    expect(branches("web")).toEqual(["main"]);
  });
});

describe("xr project remove: refused, nothing changes", () => {
  test("an unknown name: project-not-found", async () => {
    const before = state();
    const result = await json([...REMOVE, "nope"]);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("project-not-found");
    expect(state()).toEqual(before);
  });

  test("a project gone before the lock is taken: project-not-found, no lock left", async () => {
    spies.push(
      spyOn(promptAdapter, "createPrompt").mockImplementation(() => ({
        pick: () => {
          rmSync(join(login, ".crossrepo"), { recursive: true });
          return Promise.resolve("feat--login");
        },
      })),
    );
    const result = await run(REMOVE, { tty: true });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("The project feat--login is gone.");
    expect(existsSync(lockFile)).toBe(false);
  });

  test("outside a codebase: not-a-codebase", async () => {
    const result = await json([...REMOVE, "feat--login"], { cwd: iso.root });
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("not-a-codebase");
    expect(existsSync(login)).toBe(true);
  });

  for (const [kind, make] of [
    [
      "changed",
      (dir: string) => {
        writeFile(join(dir, "a.txt"), "1\n");
        git(dir, "add", "a.txt");
        git(dir, "commit", "--quiet", "-m", "a");
        writeFile(join(dir, "a.txt"), "2\n");
      },
    ],
    [
      "staged",
      (dir: string) => {
        writeFile(join(dir, "a.txt"), "1\n");
        git(dir, "add", "a.txt");
      },
    ],
    ["untracked", (dir: string) => writeFile(join(dir, "a.txt"), "1\n")],
  ] as const) {
    test(`a ${kind} file: uncommitted-changes, the hint names --force`, async () => {
      make(join(login, "api"));
      const before = state();
      const result = await json([...REMOVE, "feat--login"]);
      expect(result.code).toBe(1);
      const { error } = result.data;
      expect(error.code).toBe("uncommitted-changes");
      expect(error.hint).toContain("--force");
      expect(error.details).toEqual({
        worktrees: [
          { repo: "api", path: join(login, "api"), files: ["a.txt"] },
        ],
      });
      expect(state()).toEqual(before);
      expect(existsSync(lockFile)).toBe(false);
    });
  }

  test("the message lists each worktree with at most 5 files", async () => {
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      writeFile(join(login, "api", `f${n}.txt`), "x\n");
    }
    writeFile(join(login, "web", "w.txt"), "x\n");
    const result = await json([...REMOVE, "feat--login"]);
    const { error } = result.data;
    expect(error.message).toContain(
      `api (${join(login, "api")}): 7 uncommitted files (f1.txt, f2.txt, f3.txt, f4.txt, f5.txt and 2 more)`,
    );
    expect(error.message).toContain(
      `web (${join(login, "web")}): 1 uncommitted file (w.txt)`,
    );
    expect(error.details.worktrees[0].files).toHaveLength(7);
  });

  test("a worktree on another branch is still checked for changes", async () => {
    git(join(login, "api"), "switch", "--quiet", "-c", "other");
    writeFile(join(login, "api", "a.txt"), "1\n");
    const result = await json([...REMOVE, "feat--login"]);
    expect(result.data.error.code).toBe("uncommitted-changes");
  });

  for (const force of [false, true]) {
    test(`an extra folder: project-drift${force ? ", also with --force" : ""}`, async () => {
      mkdirSync(join(login, "notes"));
      const before = state();
      const result = await json([
        ...REMOVE,
        "feat--login",
        ...(force ? ["--force"] : []),
      ]);
      expect(result.code).toBe(1);
      const { error } = result.data;
      expect(error.code).toBe("project-drift");
      expect(error.message).toContain("notes");
      expect(error.hint).toContain("Move");
      expect(error.details).toEqual({ path: login, folders: ["notes"] });
      expect(state()).toEqual(before);
    });
  }

  test("drift is checked before uncommitted changes", async () => {
    mkdirSync(join(login, "notes"));
    writeFile(join(login, "api", "a.txt"), "1\n");
    const result = await json([...REMOVE, "feat--login"]);
    expect(result.data.error.code).toBe("project-drift");
  });

  test("a held lock: lock-held, nothing changes", async () => {
    writeFile(lockFile, `${process.ppid}\n`);
    const before = state();
    const result = await json([...REMOVE, "feat--login"]);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("lock-held");
    expect(state()).toEqual(before);
  });
});

describe("xr project remove: pre-remove", () => {
  test("runs in the project folder with CROSSREPO_HOOK=pre-remove, before the delete", async () => {
    const out = join(iso.root, "hook.txt");
    preRemove([
      `{ basename "$PWD"; echo "$CROSSREPO_HOOK"; echo "$CROSSREPO_PROJECT_REPOS"; ls api; } > "${out}"`,
    ]);
    writeFile(join(login, "api", "keep.txt"), "x\n");
    git(join(login, "api"), "add", "keep.txt");
    git(join(login, "api"), "commit", "--quiet", "-m", "keep");
    const result = await json([...REMOVE, "feat--login"]);
    expect(result.code).toBe(0);
    expect(readFileSync(out, "utf8").trim().split(/\r?\n/)).toEqual([
      "feat--login",
      "pre-remove",
      "api",
      "web",
      "keep.txt",
    ]);
    expect(result.stderr).toContain("pre-remove: {");
  });

  test("a failing line: hook-failed, the project stays whole", async () => {
    preRemove(["echo before; exit 3", "echo never"]);
    const before = state();
    const result = await json([...REMOVE, "feat--login"]);
    expect(result.code).toBe(1);
    const { error } = result.data;
    expect(error.code).toBe("hook-failed");
    expect(error.message).toBe(
      "The pre-remove hook `echo before; exit 3` failed with exit code 3.",
    );
    expect(error.hint).toContain("project.pre-remove");
    expect(error.details.hookOutput.lines).toBe("before");
    expect(state()).toEqual(before);
    expect(result.stderr).not.toContain("never");
  });

  test("--force never skips the hook", async () => {
    preRemove(["exit 1"]);
    const result = await json([...REMOVE, "feat--login", "--force"]);
    expect(result.data.error.code).toBe("hook-failed");
    expect(existsSync(login)).toBe(true);
  });

  test("the hook runs after the uncommitted check", async () => {
    const out = join(iso.root, "ran.txt");
    preRemove([`touch "${out}"`]);
    writeFile(join(login, "api", "a.txt"), "1\n");
    const result = await json([...REMOVE, "feat--login"]);
    expect(result.data.error.code).toBe("uncommitted-changes");
    expect(existsSync(out)).toBe(false);
  });

  test("no sh with pre-remove set: sh-not-found, nothing changes", async () => {
    preRemove(["true"]);
    const real = hooksAdapter.createHooks;
    spies.push(
      spyOn(hooksAdapter, "createHooks").mockImplementation((options) =>
        real({ ...options, platform: "win32", exists: () => false }),
      ),
    );
    const before = state();
    const result = await json([...REMOVE, "feat--login"]);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("sh-not-found");
    expect(state()).toEqual(before);
  });

  test("Ctrl-C while the hook runs: the hook stops, nothing changes, exit 130", async () => {
    const marker = join(iso.root, "started");
    preRemove([`touch "${marker}"; sleep 30`]);
    const before = state();
    const started = Date.now();
    const pending = json([...REMOVE, "feat--login"]);
    for (let i = 0; i < 200 && !existsSync(marker); i += 1) await sleep(50);
    interrupts.fire();
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.code).toBe(130);
    expect(result.data.error.code).toBe("interrupted");
    expect(state()).toEqual(before);
    expect(existsSync(lockFile)).toBe(false);
  });

  test("a second Ctrl-C while the hook runs: exits at once, the hook line is a leftover", async () => {
    const marker = join(iso.root, "started");
    const line = `touch "${marker}"; sleep 30`;
    preRemove([line]);
    const pending = json([...REMOVE, "feat--login"]);
    for (let i = 0; i < 200 && !existsSync(marker); i += 1) await sleep(50);
    interrupts.fire();
    interrupts.fire();
    const result = await pending;
    expect(result.code).toBe(130);
    expect(result.data.error.code).toBe("interrupted");
    expect(result.data.error.details.leftovers).toEqual([
      {
        what: "pre-remove hook",
        path: login,
        command: `Undo by hand what \`${line}\` did, if anything.`,
      },
    ]);
    expect(existsSync(login)).toBe(true);
  });

  test("an xr write command started by the hook fails with lock-held", async () => {
    const out = join(iso.root, "inner.json");
    const child = join(import.meta.dir, "..", "..", "helpers", "xr-child.ts");
    preRemove([
      `"${process.execPath}" "${child}" --json --codebase-path "${codebase}" project create other --all > "${out}" || true`,
    ]);
    const result = await json([...REMOVE, "feat--login"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8")).error.code).toBe("lock-held");
    expect(existsSync(join(projects, "other"))).toBe(false);
  });
});

describe("xr project remove: post-remove", () => {
  test("runs each line in the codebase folder with CROSSREPO_HOOK=post-remove, after the project is gone", async () => {
    const out = join(iso.root, "post.txt");
    hooks(
      {
        "post-remove": [
          `{ basename "$PWD"; echo "$CROSSREPO_HOOK"; echo "$CROSSREPO_PROJECT_PATH"; echo "$CROSSREPO_PROJECT_BRANCH"; echo "$CROSSREPO_PROJECT_REPOS"; echo "$PORT"; if [ -e "$CROSSREPO_PROJECT_PATH" ]; then echo exists; else echo gone; fi; git -C api worktree list | wc -l | tr -d ' '; } > "${out}"`,
          `echo second >> "${out}"`,
        ],
      },
      "  vars:\n    PORT: 5432",
    );
    const result = await json([...REMOVE, "feat--login", "--delete-branch"]);
    expect(result.code).toBe(0);
    expect(result.data.warnings).toEqual([]);
    expect(readFileSync(out, "utf8").trim().split(/\r?\n/)).toEqual([
      "shop",
      "post-remove",
      login,
      "feat/login",
      "api",
      "web",
      "5432",
      "gone",
      "1",
      "second",
    ]);
    expect(result.stderr).toContain("post-remove: {");
    expect(branches("api")).toEqual(["main"]);
  });

  test("a failing line: exit 0 with a hook-failed warning and its output, the lines after it do not run", async () => {
    const never = join(iso.root, "never.txt");
    hooks({
      "post-remove": ["echo out-1; echo out-2 >&2; exit 4", `touch "${never}"`],
    });
    const result = await json([...REMOVE, "feat--login"]);
    expect(result.code).toBe(0);
    expect(result.data.ok).toBe(true);
    expect(result.data.warnings).toEqual([
      {
        code: "hook-failed",
        message:
          "The post-remove hook `echo out-1; echo out-2 >&2; exit 4` failed with exit code 4.",
        hint: `The project is removed. Fix the line in \`project.post-remove\`, then run by hand the lines that did not run: \`echo out-1; echo out-2 >&2; exit 4\`, \`touch "${never}"\`.`,
        lines: ["out-1", "out-2"],
      },
    ]);
    expect(existsSync(never)).toBe(false);
    expect(state()).toEqual(removedState());
    expect(existsSync(lockFile)).toBe(false);
  });

  test("a failing line in text mode: the warning, the hint and the output lines on stderr", async () => {
    hooks({ "post-remove": ["echo out-1; exit 1"] });
    const result = await run([...REMOVE, "feat--login"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain(
      "! The post-remove hook `echo out-1; exit 1` failed with exit code 1.\n  The project is removed. Fix the line in `project.post-remove`, then run by hand the lines that did not run: `echo out-1; exit 1`.\n    out-1\n",
    );
    expect(existsSync(login)).toBe(false);
  });

  test("Ctrl-C while a line runs: the line stops, the rest do not run, a warning, exit 0", async () => {
    const marker = join(iso.root, "started");
    const never = join(iso.root, "never.txt");
    hooks({
      "post-remove": [`touch "${marker}"; sleep 30`, `touch "${never}"`],
    });
    const started = Date.now();
    const pending = json([...REMOVE, "feat--login"]);
    for (let i = 0; i < 200 && !existsSync(marker); i += 1) await sleep(50);
    interrupts.fire();
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.code).toBe(0);
    expect(result.data.ok).toBe(true);
    expect(result.data.warnings).toHaveLength(1);
    expect(result.data.warnings[0].code).toBe("hook-failed");
    expect(result.data.warnings[0].message).toBe(
      `The post-remove hook \`touch "${marker}"; sleep 30\` was stopped by Ctrl-C.`,
    );
    expect(result.data.warnings[0].hint).toBe(
      `The project is removed. Run by hand the lines that did not run, if they are needed: \`touch "${marker}"; sleep 30\`, \`touch "${never}"\`.`,
    );
    expect(existsSync(never)).toBe(false);
    expect(state()).toEqual(removedState());
    expect(existsSync(lockFile)).toBe(false);
  });

  test("Ctrl-C between two lines: the rest do not run, the warning names them, exit 0", async () => {
    hooks({ "post-remove": ["first", "second", "third"] });
    const ran: string[] = [];
    const real = hooksAdapter.createHooks;
    spies.push(
      spyOn(hooksAdapter, "createHooks").mockImplementation((options) => {
        const hooksPort = real(options);
        return {
          ...hooksPort,
          run: async ({ command }) => {
            ran.push(command);
            if (command === "first") interrupts.fire();
            return { ok: true };
          },
        };
      }),
    );
    const result = await json([...REMOVE, "feat--login"]);
    expect(result.code).toBe(0);
    expect(ran).toEqual(["first"]);
    expect(result.data.warnings).toEqual([
      {
        code: "hook-failed",
        message:
          "The post-remove hook was stopped by Ctrl-C before `second`, `third` ran.",
        hint: "The project is removed. Run by hand the lines that did not run, if they are needed: `second`, `third`.",
      },
    ]);
    expect(state()).toEqual(removedState());
  });

  test("a failed delete step: post-remove does not run", async () => {
    const marker = join(iso.root, "ran.txt");
    hooks({ "post-remove": [`touch "${marker}"`] });
    fakeGit((g) => withFault(g, "worktreeRemove", 2));
    const result = await json([...REMOVE, "feat--login"]);
    expect(result.code).toBe(1);
    expect(result.data.error.details.leftovers.length).toBeGreaterThan(0);
    expect(existsSync(marker)).toBe(false);
  });

  test("a failed pre-remove: nothing is removed, post-remove does not run", async () => {
    const marker = join(iso.root, "ran.txt");
    hooks({ "pre-remove": ["exit 1"], "post-remove": [`touch "${marker}"`] });
    const before = state();
    const result = await json([...REMOVE, "feat--login"]);
    expect(result.data.error.code).toBe("hook-failed");
    expect(result.data.error.message).toContain("pre-remove");
    expect(existsSync(marker)).toBe(false);
    expect(state()).toEqual(before);
  });

  test("no sh with only post-remove set: sh-not-found, nothing changes", async () => {
    hooks({ "post-remove": ["true"] });
    const real = hooksAdapter.createHooks;
    spies.push(
      spyOn(hooksAdapter, "createHooks").mockImplementation((options) =>
        real({ ...options, platform: "win32", exists: () => false }),
      ),
    );
    const before = state();
    const result = await json([...REMOVE, "feat--login"]);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("sh-not-found");
    expect(state()).toEqual(before);
  });
});

describe("xr project remove: delete phase stops", () => {
  test("a failed worktree remove: stop, the failed step and the rest are leftovers", async () => {
    fakeGit((g) => withFault(g, "worktreeRemove", 2));
    const result = await json([...REMOVE, "feat--login", "--delete-branch"]);
    expect(result.code).toBe(1);
    expect(result.data.error.message).toContain("fault in worktreeRemove");
    const web = join(codebase, "web");
    const api = join(codebase, "api");
    expect(result.data.error.details.leftovers).toEqual([
      {
        what: "worktree of web",
        path: join(login, "web"),
        command: `git -C "${web}" worktree remove --force "${join(login, "web")}"`,
      },
      {
        what: "branch feat/login of api",
        path: api,
        command: `git -C "${api}" branch -d feat/login`,
      },
      {
        what: "branch feat/login of web",
        path: web,
        command: `git -C "${web}" branch -d feat/login`,
      },
      { what: "project folder", path: login, command: `rm -rf "${login}"` },
    ]);
    // The first worktree is gone; the rest stays.
    expect(worktreePaths("api")).toEqual([api]);
    expect(worktreePaths("web")).toEqual([web, join(login, "web")]);
    expect(existsSync(lockFile)).toBe(false);
  });

  test("a failed branch delete that is not a merge refusal: stop with leftovers", async () => {
    fakeGit((g) =>
      withFault(
        g,
        "branchDelete",
        1,
        new GitError({
          args: ["branch", "-d", "--", "feat/login"],
          exitCode: 1,
          stderr: "error: something else",
        }),
      ),
    );
    const result = await json([...REMOVE, "feat--login", "--delete-branch"]);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("git-failed");
    expect(
      result.data.error.details.leftovers.map(
        (leftover: { what: string }) => leftover.what,
      ),
    ).toEqual([
      "branch feat/login of api",
      "branch feat/login of web",
      "project folder",
    ]);
    expect(existsSync(login)).toBe(true);
  });

  test("Ctrl-C in the delete phase: the step ends, the rest are leftovers, exit 130", async () => {
    fakeGit((g) => afterCall(g, "worktreeRemove", 1, () => interrupts.fire()));
    const result = await json([...REMOVE, "feat--login"]);
    expect(result.code).toBe(130);
    expect(result.data.error.code).toBe("interrupted");
    const web = join(codebase, "web");
    expect(result.data.error.details.leftovers).toEqual([
      {
        what: "worktree of web",
        path: join(login, "web"),
        command: `git -C "${web}" worktree remove --force "${join(login, "web")}"`,
      },
      { what: "project folder", path: login, command: `rm -rf "${login}"` },
    ]);
    expect(worktreePaths("api")).toEqual([join(codebase, "api")]);
    expect(existsSync(login)).toBe(true);
    expect(existsSync(lockFile)).toBe(false);
  });

  test("a missing worktree folder leftover uses git worktree prune", async () => {
    rmSync(join(login, "api"), { recursive: true });
    fakeGit((g) => withFault(g, "worktreePrune", 1));
    const result = await json([...REMOVE, "feat--login"]);
    expect(result.code).toBe(1);
    expect(result.data.error.details.leftovers[0]).toEqual({
      what: "worktree of api",
      path: join(login, "api"),
      command: `git -C "${join(codebase, "api")}" worktree prune`,
    });
  });
});

describe("xr project remove of the current folder", () => {
  for (const sub of ["", "api"]) {
    test(`cwd ${sub ? "in a worktree of" : "is"} the project: xr moves to the codebase first, then a note`, async () => {
      const cwd = join(login, sub);
      // Discovery never looks at a parent folder, so a worktree needs `--codebase-path`.
      const where = sub ? ["--codebase-path", codebase] : [];
      const result = await json([...where, ...REMOVE, "feat--login"], { cwd });
      expect(result.code).toBe(0);
      expect(chdirs).toEqual([codebase]);
      expect(result.data.notes).toEqual([
        `Your shell is in a deleted folder. Run \`cd ${codebase}\`.`,
      ]);
      expect(existsSync(login)).toBe(false);
    });
  }

  test("text mode: the note is the last line", async () => {
    const result = await run([...REMOVE, "feat--login"], { cwd: login });
    expect(result.code).toBe(0);
    expect(result.stdout.trimEnd().split("\n").at(-1)).toBe(
      `Your shell is in a deleted folder. Run \`cd ${codebase}\`.`,
    );
  });

  test("the codebase through a symlink: the project folder still counts as the current folder", async () => {
    const link = join(iso.root, "shop-link");
    symlinkSync(codebase, link, "junction");
    const result = await json(
      ["--codebase-path", link, ...REMOVE, "feat--login"],
      { cwd: login },
    );
    expect(result.code).toBe(0);
    expect(chdirs).toEqual([link]);
    expect(result.data.notes).toEqual([
      `Your shell is in a deleted folder. Run \`cd ${link}\`.`,
    ]);
    expect(existsSync(login)).toBe(false);
  });

  test("a refused remove never moves", async () => {
    mkdirSync(join(login, "notes"));
    const result = await json([...REMOVE, "feat--login"], { cwd: login });
    expect(result.data.error.code).toBe("project-drift");
    expect(chdirs).toEqual([]);
  });
});

describe("xr project remove with no project", () => {
  beforeEach(async () => {
    const made = await run(["project", "create", "fix/bug", "api"]);
    if (made.code !== 0) throw new Error(made.stderr);
  });

  test("in a terminal: picks from the folder names with the branches as hints, then removes", async () => {
    const requests = fakePick(spies, "fix--bug");
    const result = await run(REMOVE, { tty: true });
    expect(result.code).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      argument: "project",
      choices: ["feat--login", "fix--bug"],
      hints: { "feat--login": "feat/login", "fix--bug": "fix/bug" },
    });
    expect(existsSync(join(projects, "fix--bug"))).toBe(false);
    expect(existsSync(login)).toBe(true);
  });

  test("the picker runs before the lock", async () => {
    const lockAtPick: boolean[] = [];
    spies.push(
      spyOn(promptAdapter, "createPrompt").mockImplementation(() => ({
        pick: () => {
          lockAtPick.push(existsSync(lockFile));
          return Promise.resolve("fix--bug");
        },
      })),
    );
    const result = await run(REMOVE, { tty: true });
    expect(result.code).toBe(0);
    expect(lockAtPick).toEqual([false]);
  });

  test("Escape in the picker: interrupted, exit 130, nothing changes", async () => {
    fakeKeys(spies, [ESCAPE]);
    const before = state();
    const result = await run(REMOVE, { tty: true });
    expect(result.code).toBe(130);
    expect(state()).toEqual(before);
  });

  for (const [mode, argv, tty] of [
    ["no TTY", ["--json", ...REMOVE], false],
    ["--no-interactive", ["--no-interactive", "--json", ...REMOVE], true],
  ] as const) {
    test(`${mode}: missing-argument with the project names, exit 2`, async () => {
      const before = state();
      const result = await run([...argv], { tty });
      expect(result.code).toBe(2);
      const { error } = JSON.parse(result.stdout);
      expect(error.code).toBe("missing-argument");
      expect(error.details).toEqual({
        argument: "project",
        choices: ["feat--login", "fix--bug"],
      });
      expect(state()).toEqual(before);
    });
  }

  test("a broken record is a warning; the choices are the valid projects", async () => {
    writeFile(join(projects, "broken", ".crossrepo", "project.yaml"), "x: [\n");
    const result = await run(["--json", ...REMOVE]);
    expect(result.code).toBe(2);
    const data = JSON.parse(result.stdout);
    expect(data.error.code).toBe("missing-argument");
    expect(data.error.details.choices).toEqual(["feat--login", "fix--bug"]);
    expect(data.warnings.map((w: { code: string }) => w.code)).toEqual([
      "invalid-project-record",
    ]);
  });

  test("in a project folder: never the current project, missing-argument", async () => {
    const result = await run(["--json", ...REMOVE], { cwd: login });
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout).error.code).toBe("missing-argument");
    expect(existsSync(login)).toBe(true);
  });

  test("in a project folder, by name: removes the other project", async () => {
    const result = await json([...REMOVE, "fix/bug"], { cwd: login });
    expect(result.code).toBe(0);
    expect(existsSync(join(projects, "fix--bug"))).toBe(false);
    expect(chdirs).toEqual([]);
  });
});

describe("xr project remove with a reserved var name", () => {
  test("fails with reserved-var-name before the picker: no lock, no change", async () => {
    const requests = fakePick(spies, "feat--login");
    writeConfig("project:\n  vars:\n    crossrepo_x: 1\n");
    const before = state();
    const result = await json(REMOVE, { tty: true });
    expect(result.code).toBe(1);
    expect(result.data.error).toEqual({
      code: "reserved-var-name",
      message: `Reserved var names in \`project.vars\`: \`crossrepo_x\` (${configFile}).`,
      hint: "xr codebase doctor",
    });
    expect(requests).toHaveLength(0);
    expect(state()).toEqual(before);
    expect(existsSync(lockFile)).toBe(false);
  });

  test("in the project folder: still fails first", async () => {
    writeConfig("project:\n  vars:\n    CROSSREPO_X: 1\n");
    const before = state();
    const result = await json(REMOVE, { cwd: login });
    expect(result.data.error.code).toBe("reserved-var-name");
    expect(state()).toEqual(before);
  });
});
