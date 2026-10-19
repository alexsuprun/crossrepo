import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import * as gitAdapter from "../../../src/adapters/git/index.ts";
import { main } from "../../../src/cli/index.ts";
import { GitError } from "../../../src/errors/index.ts";
import { git, makeRepos, pushCommit } from "../../helpers/git.ts";
import {
  type FakeInterrupts,
  fakeInterrupts,
} from "../../helpers/interrupts.ts";
import { type Isolation, isolate, writeFile } from "../../helpers/isolate.ts";

let iso: Isolation;
let codebase: string;
let configFile: string;
let lockFile: string;
let spies: { mockRestore(): void }[];
let interrupts: FakeInterrupts;
/** Bare origins outside the codebase, as paths. */
let origins: Record<string, string>;

const PULL = ["codebase", "pull"];
const PULL_FAILED_HINT =
  "Fix each failed repo, then run `xr codebase pull` again.";

beforeEach(() => {
  iso = isolate();
  codebase = join(iso.root, "shop");
  mkdirSync(codebase);
  configFile = join(codebase, ".crossrepo", "config.yaml");
  lockFile = join(codebase, ".crossrepo", "xr.lock");
  spies = [];
  interrupts = fakeInterrupts();
  origins = makeRepos(join(iso.root, "upstream"), {
    api: {},
    web: { branch: "trunk" },
    docs: {},
  }) as Record<string, string>;
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  iso.restore();
});

/** Writes the codebase config with these repos, in this order. */
function config(names: string[]): string {
  const lines = names.flatMap((name) => [
    `  ${name}:`,
    `    remote: ${pathToFileURL(origins[name] ?? join(iso.root, `${name}.git`)).href}`,
    "    default-branch: main",
  ]);
  const text = lines.length ? `repos:\n${lines.join("\n")}\n` : "repos: {}\n";
  writeFile(configFile, text);
  return text;
}

/** Clones the origin of each repo into the codebase, so its branch tracks the origin. */
function onDisk(...names: string[]) {
  for (const name of names) {
    git(codebase, "clone", "--quiet", origins[name] as string, name);
  }
}

const dir = (name: string) => join(codebase, name);
const head = (name: string) => git(dir(name), "rev-parse", "HEAD").trim();
const branch = (name: string) =>
  git(dir(name), "branch", "--show-current").trim();

function testEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  return env;
}

async function run(
  argv: string[],
  {
    cwd = codebase,
    env = testEnv(),
  }: { cwd?: string; env?: Record<string, string | undefined> } = {},
) {
  let stdout = "";
  let stderr = "";
  const code = await main({
    version: "1.2.3",
    argv,
    env,
    isTTY: { stdin: false, stdout: false, stderr: false },
    cwd,
    home: iso.home,
    interrupts,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

async function json(argv: string[], options?: Parameters<typeof run>[1]) {
  const result = await run(["--json", ...argv], options);
  return { ...result, data: JSON.parse(result.stdout) };
}

function fakeGit(wrap: (git: gitAdapter.Git) => gitAdapter.Git) {
  const real = gitAdapter.createGit;
  spies.push(
    spyOn(gitAdapter, "createGit").mockImplementation((options) =>
      wrap(real(options)),
    ),
  );
}

/** Counts the calls of `pull`. */
function countPull() {
  const calls = { pull: 0 };
  fakeGit((git) => ({
    ...git,
    async pull(...args) {
      calls.pull += 1;
      return git.pull(...args);
    },
  }));
  return calls;
}

/** Fires one Ctrl-C at the first output of the `nth` pull, so the signal stops a live git. */
function interruptGit(nth: number) {
  const real = gitAdapter.createGit;
  let pulls = 0;
  let fired = false;
  spies.push(
    spyOn(gitAdapter, "createGit").mockImplementation((options) => {
      const inner = real({
        ...options,
        stderr(text) {
          options.stderr?.(text);
          if (fired || pulls !== nth) return;
          fired = true;
          interrupts.fire();
        },
      });
      return {
        ...inner,
        pull(...args) {
          pulls += 1;
          return inner.pull(...args);
        },
      };
    }),
  );
}

/** Makes each `pull` throw a `GitError` with this stderr. */
function failPull(stderr: string) {
  fakeGit((git) => ({
    ...git,
    async pull() {
      throw new GitError({ args: ["pull"], exitCode: 1, stderr });
    },
  }));
}

const ok = (repo: string) => ({ repo, status: "ok" });
const stopped = (repo: string) => ({
  repo,
  status: "skipped",
  message: "interrupted",
});
const again = "then run `xr codebase pull` again.";

describe("xr codebase pull", () => {
  test("--json fast-forwards a repo that is behind, keeps one up to date, in config order", async () => {
    onDisk("web", "api");
    const before = config(["web", "api"]);
    const target = pushCommit(origins.api as string);
    const webHead = head("web");
    const result = await run(["--json", ...PULL]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      `${JSON.stringify({ ok: true, warnings: [], repos: [ok("web"), ok("api")] })}\n`,
    );
    expect(result.stderr.indexOf("✓ web")).toBeLessThan(
      result.stderr.indexOf("✓ api"),
    );
    // git's own output is live on stderr, before the repo line.
    expect(result.stderr).toContain("Already up to date.");
    expect(result.stderr.indexOf("Fast-forward")).toBeLessThan(
      result.stderr.indexOf("✓ api"),
    );
    expect(head("api")).toBe(target);
    expect(head("web")).toBe(webHead);
    expect(branch("web")).toBe("trunk");
    expect(branch("api")).toBe("main");
    expect(readFileSync(configFile, "utf8")).toBe(before);
    expect(existsSync(join(codebase, "AGENTS.md"))).toBe(false);
    expect(existsSync(lockFile)).toBe(false);
    expect(interrupts.listening).toBe(0);
  });

  test("pulls the checked-out branch from its own upstream, not the config remote", async () => {
    onDisk("api");
    git(dir("api"), "checkout", "--quiet", "-b", "feat");
    git(dir("api"), "push", "--quiet", "--set-upstream", "origin", "feat");
    // The config names an origin that does not exist.
    writeFile(
      configFile,
      "repos:\n  api:\n    remote: /nowhere/api.git\n    default-branch: main\n",
    );
    const target = pushCommit(origins.api as string, { branch: "feat" });
    const result = await json(PULL);
    expect(result.code).toBe(0);
    expect(result.data.repos).toEqual([ok("api")]);
    expect(branch("api")).toBe("feat");
    expect(head("api")).toBe(target);
  });

  test("text mode: git output and one line per repo on stderr, the repo lines on stdout", async () => {
    onDisk("api");
    config(["api", "web"]);
    const result = await run(PULL);
    expect(result.code).toBe(0);
    const lines =
      "✓ api\n– web: missing\n  Clone the missing repos with `xr codebase clone`.\n";
    expect(result.stdout).toBe(lines);
    expect(result.stderr).toContain("Already up to date.");
    expect(result.stderr).toEndWith(lines);
  });

  test("a missing repo: skipped with the clone hint, git not run, exit 0", async () => {
    onDisk("web");
    config(["api", "web"]);
    const calls = countPull();
    const result = await json(PULL);
    expect(result.code).toBe(0);
    expect(result.data).toEqual({
      ok: true,
      warnings: [],
      repos: [
        {
          repo: "api",
          status: "skipped",
          message: "missing",
          hint: "Clone the missing repos with `xr codebase clone`.",
        },
        ok("web"),
      ],
    });
    expect(calls.pull).toBe(1);
    expect(existsSync(dir("api"))).toBe(false);
  });

  test("a folder with no .git: failed with the clone hint, git not run, never touched; the others still run", async () => {
    onDisk("web");
    config(["api", "web"]);
    writeFile(join(dir("api"), "notes.txt"), "mine");
    const target = pushCommit(origins.web as string, { branch: "trunk" });
    const calls = countPull();
    const result = await json(PULL);
    expect(result.code).toBe(1);
    expect(result.data).toEqual({
      ok: false,
      warnings: [],
      repos: [
        {
          repo: "api",
          status: "failed",
          message: "folder has no .git",
          hint: `Move or delete ${dir("api")}, then run \`xr codebase clone\` again.`,
        },
        ok("web"),
      ],
      error: {
        code: "repos-failed",
        message: "1 of 2 repos failed: api.",
        hint: PULL_FAILED_HINT,
      },
    });
    expect(calls.pull).toBe(1);
    expect(head("web")).toBe(target);
    expect(readFileSync(join(dir("api"), "notes.txt"), "utf8")).toBe("mine");
    expect(existsSync(join(dir("api"), ".git"))).toBe(false);
    expect(existsSync(lockFile)).toBe(false);
    expect(interrupts.listening).toBe(0);
  });

  test("cannot fast-forward: failed with the git error and a merge hint, no commit made, also with pull.rebase=true", async () => {
    onDisk("api", "web");
    config(["api", "web"]);
    pushCommit(origins.api as string);
    git(dir("api"), "config", "pull.rebase", "true");
    git(dir("api"), "commit", "--quiet", "--allow-empty", "-m", "local");
    const local = head("api");
    const webTarget = pushCommit(origins.web as string, { branch: "trunk" });
    const result = await json(PULL);
    expect(result.code).toBe(1);
    expect(result.data.error).toEqual({
      code: "repos-failed",
      message: "1 of 2 repos failed: api.",
      hint: PULL_FAILED_HINT,
    });
    expect(result.data.repos).toEqual([
      {
        repo: "api",
        status: "failed",
        message: "fatal: Not possible to fast-forward, aborting.",
        hint: `Merge or rebase by hand in ${dir("api")}, ${again}`,
      },
      ok("web"),
    ]);
    expect(head("api")).toBe(local);
    expect(git(dir("api"), "log", "-1", "--format=%s").trim()).toBe("local");
    expect(branch("api")).toBe("main");
    expect(head("web")).toBe(webTarget);
    expect(existsSync(lockFile)).toBe(false);
  });

  test("no upstream: failed with the git message and an upstream hint", async () => {
    onDisk("api");
    config(["api"]);
    git(dir("api"), "checkout", "--quiet", "-b", "local-only");
    const before = head("api");
    const result = await json(PULL);
    expect(result.code).toBe(1);
    expect(result.data.repos).toEqual([
      {
        repo: "api",
        status: "failed",
        message: "There is no tracking information for the current branch.",
        hint: `Set an upstream for the branch in ${dir("api")} (git branch --set-upstream-to), ${again}`,
      },
    ]);
    expect(branch("api")).toBe("local-only");
    expect(head("api")).toBe(before);
  });

  test("detached HEAD: failed with the git message and a checkout hint, HEAD stays", async () => {
    onDisk("api");
    config(["api"]);
    git(dir("api"), "checkout", "--quiet", "--detach");
    const before = head("api");
    pushCommit(origins.api as string);
    const result = await json(PULL);
    expect(result.code).toBe(1);
    expect(result.data.repos).toEqual([
      {
        repo: "api",
        status: "failed",
        message: "You are not currently on a branch.",
        hint: `Check out a branch in ${dir("api")}, ${again}`,
      },
    ]);
    expect(branch("api")).toBe("");
    expect(head("api")).toBe(before);
  });

  test("an untracked file in the way: failed with a stash hint, the file untouched", async () => {
    onDisk("api");
    config(["api"]);
    const before = head("api");
    pushCommit(origins.api as string, { file: "notes.txt" });
    writeFile(join(dir("api"), "notes.txt"), "mine");
    const result = await json(PULL);
    expect(result.code).toBe(1);
    expect(result.data.repos).toEqual([
      {
        repo: "api",
        status: "failed",
        message:
          "error: The following untracked working tree files would be overwritten by merge:",
        hint: `Commit or stash the changes in ${dir("api")}, ${again}`,
      },
    ]);
    expect(readFileSync(join(dir("api"), "notes.txt"), "utf8")).toBe("mine");
    expect(head("api")).toBe(before);
  });

  test("a tracked change in the way: failed with a stash hint, the change untouched", async () => {
    pushCommit(origins.api as string, { file: "notes.txt" });
    onDisk("api");
    config(["api"]);
    const before = head("api");
    pushCommit(origins.api as string, { file: "notes.txt" });
    writeFile(join(dir("api"), "notes.txt"), "mine");
    const result = await json(PULL);
    expect(result.code).toBe(1);
    expect(result.data.repos).toEqual([
      {
        repo: "api",
        status: "failed",
        message:
          "error: Your local changes to the following files would be overwritten by merge:",
        hint: `Commit or stash the changes in ${dir("api")}, ${again}`,
      },
    ]);
    expect(readFileSync(join(dir("api"), "notes.txt"), "utf8")).toBe("mine");
    expect(head("api")).toBe(before);
  });

  test("another git failure: the first fatal line, no repo hint; the others still run", async () => {
    onDisk("api", "web");
    config(["api", "web"]);
    git(
      dir("api"),
      "remote",
      "set-url",
      "origin",
      join(iso.root, "gone", "api.git"),
    );
    const result = await json(PULL);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("repos-failed");
    expect(result.data.error.hint).toBe(PULL_FAILED_HINT);
    const [api, web] = result.data.repos;
    expect(api.status).toBe("failed");
    expect(api.message).toStartWith("fatal:");
    expect(api.message).not.toContain("\n");
    expect(api.hint).toBeUndefined();
    expect(web).toEqual(ok("web"));
    expect(existsSync(lockFile)).toBe(false);
  });

  test("the message is the first fatal or error line, else the first line that is not a hint", async () => {
    onDisk("api");
    config(["api"]);
    failPull("From x\nhint: try this\nerror: first\nfatal: second");
    expect((await json(PULL)).data.repos[0].message).toBe("error: first");
  });

  test("with no fatal or error line, hint lines are skipped", async () => {
    onDisk("api");
    config(["api"]);
    failPull("hint: one\nhint:\nSomething went wrong.\nmore");
    expect((await json(PULL)).data.repos[0].message).toBe(
      "Something went wrong.",
    );
  });

  test("a failed pull with no stderr: the message of the error", async () => {
    onDisk("api");
    config(["api"]);
    failPull("");
    const result = await json(PULL);
    expect(result.data.repos).toEqual([
      {
        repo: "api",
        status: "failed",
        message: "`git pull` failed with exit code 1.",
      },
    ]);
  });

  test("an error that is not a GitError ends the run as internal, the lock is released", async () => {
    onDisk("api");
    config(["api"]);
    fakeGit((git) => ({
      ...git,
      async pull() {
        throw new Error("boom");
      },
    }));
    const result = await json(PULL);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("internal");
    expect(existsSync(lockFile)).toBe(false);
    expect(interrupts.listening).toBe(0);
  });

  test("text mode and a failure: stdout is empty, the repos and the error go to stderr", async () => {
    config(["api"]);
    mkdirSync(dir("api"));
    const result = await run(PULL);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("✗ api: folder has no .git\n");
    expect(result.stderr).toEndWith(
      `error: 1 of 1 repo failed: api.\n${PULL_FAILED_HINT}\n`,
    );
  });

  test.skipIf(process.platform === "win32")(
    "git older than 2.27: git-too-old, nothing pulled, the lock is released",
    async () => {
      onDisk("api");
      config(["api"]);
      const before = head("api");
      pushCommit(origins.api as string);
      const bin = join(iso.root, "bin");
      const script = writeFile(
        join(bin, "git"),
        '#!/bin/sh\necho "git version 2.20.1"\n',
      );
      chmodSync(script, 0o755);
      const env = {
        ...testEnv(),
        PATH: [bin, process.env.PATH].join(delimiter),
      };
      const result = await json(PULL, { env });
      expect(result.code).toBe(1);
      expect(result.data.error.code).toBe("git-too-old");
      expect(head("api")).toBe(before);
      expect(existsSync(lockFile)).toBe(false);
    },
  );

  test("git not on PATH: one git-failed error before any pull, the lock is released", async () => {
    onDisk("api", "web");
    config(["api", "web"]);
    const empty = join(iso.root, "empty");
    mkdirSync(empty);
    const result = await json(PULL, {
      env: { ...testEnv(), PATH: empty, Path: empty },
    });
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("git-failed");
    expect(result.data.error.message).toContain("not found");
    expect(result.data.repos).toBeUndefined();
    expect(existsSync(lockFile)).toBe(false);
    expect(interrupts.listening).toBe(0);
  });

  test("an empty codebase: no repo lines, repos: [], exit 0", async () => {
    config([]);
    const result = await json(PULL);
    expect(result.code).toBe(0);
    expect(result.data).toEqual({ ok: true, warnings: [], repos: [] });
    expect(result.stderr).toBe("");
    const text = await run(PULL);
    expect(text).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  test("not a codebase: not-a-codebase, no lock", async () => {
    const result = await json(PULL);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("not-a-codebase");
    expect(existsSync(join(codebase, ".crossrepo"))).toBe(false);
  });

  test("a project folder: not-a-codebase, nothing pulled", async () => {
    onDisk("api");
    config(["api"]);
    const before = head("api");
    pushCommit(origins.api as string);
    const project = join(codebase, ".projects", "feat");
    writeFile(join(project, ".crossrepo", "project.yaml"), "codebase: ../..\n");
    const result = await json(PULL, { cwd: project });
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("not-a-codebase");
    expect(head("api")).toBe(before);
    expect(existsSync(lockFile)).toBe(false);
  });

  test("a lock held by a running process: lock-held, nothing pulled", async () => {
    onDisk("api");
    config(["api"]);
    const before = head("api");
    pushCommit(origins.api as string);
    writeFile(lockFile, `${process.ppid}\n`);
    const result = await json(PULL);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("lock-held");
    expect(result.data.repos).toBeUndefined();
    expect(head("api")).toBe(before);
    expect(readFileSync(lockFile, "utf8")).toBe(`${process.ppid}\n`);
  });

  test("an argument or an own option: usage, exit 2", async () => {
    onDisk("api");
    config(["api"]);
    const before = head("api");
    pushCommit(origins.api as string);
    for (const extra of ["api", "--rebase"]) {
      const result = await json([...PULL, extra]);
      expect(result.code).toBe(2);
      expect(result.data.error.code).toBe("usage");
    }
    expect(head("api")).toBe(before);
  });

  test("xr codebase --help lists pull", async () => {
    const result = await run(["codebase", "--help"]);
    expect(result.stdout).toContain("pull");
  });
});

describe("xr codebase pull Ctrl-C", () => {
  test("during a pull: git stops, it and the rest are interrupted, the ones done stay, exit 130", async () => {
    onDisk("api", "web", "docs");
    config(["api", "web", "docs"]);
    const apiTarget = pushCommit(origins.api as string);
    pushCommit(origins.web as string, { branch: "trunk" });
    pushCommit(origins.docs as string);
    const docsBefore = head("docs");
    interruptGit(2);
    const result = await json(PULL);
    expect(result.code).toBe(130);
    expect(result.data).toEqual({
      ok: false,
      warnings: [],
      repos: [ok("api"), stopped("web"), stopped("docs")],
      error: { code: "interrupted", message: "Stopped by Ctrl-C." },
    });
    expect(head("api")).toBe(apiTarget);
    expect(head("docs")).toBe(docsBefore);
    expect(branch("web")).toBe("trunk");
    expect(existsSync(lockFile)).toBe(false);
    expect(interrupts.listening).toBe(0);
  });

  test("a second Ctrl-C: exit 130 at once, the lock file stays", async () => {
    onDisk("api", "web");
    config(["api", "web"]);
    let finish: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    fakeGit((git) => ({
      ...git,
      pull(_dir, options) {
        interrupts.fire();
        interrupts.fire();
        return new Promise((_, reject) => {
          const stop = () =>
            setTimeout(() => {
              finish();
              reject(new Error("stopped"));
            }, 0);
          options?.signal?.addEventListener("abort", stop);
          if (options?.signal?.aborted) stop();
        });
      },
    }));
    const result = await json(PULL);
    expect(result.code).toBe(130);
    expect(result.data.error).toEqual({
      code: "interrupted",
      message: "Stopped by a second Ctrl-C.",
    });
    expect(result.data.repos).toEqual([stopped("api"), stopped("web")]);
    expect(existsSync(lockFile)).toBe(true);
    expect(interrupts.listening).toBe(0);
    await done;
  });
});
