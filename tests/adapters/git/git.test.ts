import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createGit, parseVersion } from "../../../src/adapters/git/index.ts";
import { GitError, XrError } from "../../../src/errors/index.ts";
import { git, makeRepos, pushCommit } from "../../helpers/git.ts";
import { type Isolation, isolate, writeFile } from "../../helpers/isolate.ts";

let iso: Isolation;
let root: string;

beforeEach(() => {
  iso = isolate();
  root = join(iso.root, "shop");
  mkdirSync(root);
});

afterEach(() => {
  iso.restore();
});

const env = () => ({ ...process.env });

describe("createGit with real repos", () => {
  test("version gives the installed version", async () => {
    expect(
      await createGit({ interactive: false, env: env() }).version(),
    ).toMatch(/^\d+\.\d+/);
  });

  test("originUrl gives the origin URL as written, without insteadOf", async () => {
    const remotes = makeRepos(root, { api: {}, solo: { origin: false } });
    git(
      join(root, "api"),
      "config",
      "url.https://example.com/.insteadOf",
      remotes.api as string,
    );
    const adapter = createGit({ interactive: false, env: env() });
    expect(await adapter.originUrl(join(root, "api"))).toBe(
      remotes.api as string,
    );
    expect(await adapter.originUrl(join(root, "solo"))).toBeUndefined();
  });

  test("originUrl gives undefined for an empty origin URL", async () => {
    makeRepos(root, { api: { origin: false } });
    git(join(root, "api"), "config", "remote.origin.url", "");
    const adapter = createGit({ interactive: false, env: env() });
    expect(await adapter.originUrl(join(root, "api"))).toBeUndefined();
  });

  test("originHead gives the default branch without origin/, or undefined", async () => {
    makeRepos(root, {
      api: { branch: "trunk" },
      web: { head: false },
      solo: { origin: false },
    });
    const adapter = createGit({ interactive: false, env: env() });
    expect(await adapter.originHead(join(root, "api"))).toBe("trunk");
    expect(await adapter.originHead(join(root, "web"))).toBeUndefined();
    expect(await adapter.originHead(join(root, "solo"))).toBeUndefined();
  });

  test("a folder that is not a repo fails with a GitError", async () => {
    const dir = join(iso.root, "plain");
    mkdirSync(dir);
    const error = await createGit({ interactive: false, env: env() })
      .originHead(dir)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GitError);
    expect(error).toMatchObject({
      code: "git-failed",
      exitCode: 128,
      args: [
        "-C",
        dir,
        "symbolic-ref",
        "--quiet",
        "--short",
        "refs/remotes/origin/HEAD",
      ],
    });
    expect((error as GitError).stderr).toContain("not a git repository");
  });

  test("git missing from PATH is a GitError", async () => {
    const empty = join(iso.root, "empty");
    mkdirSync(empty);
    const error = await createGit({
      interactive: false,
      env: { ...env(), PATH: empty, Path: empty },
    })
      .version()
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).message).toContain("not found");
  });
});

describe("createGit clone", () => {
  test("clones the URL into dest, keeps the URL as given and streams git stderr", async () => {
    const remotes = makeRepos(root, { api: { branch: "trunk" } });
    const url = pathToFileURL(remotes.api as string).href;
    const dest = join(iso.root, "copy", "api");
    mkdirSync(join(iso.root, "copy"));
    let streamed = "";
    const adapter = createGit({
      interactive: false,
      env: env(),
      stderr: (text) => {
        streamed += text;
      },
    });
    await adapter.clone(url, dest);
    expect(existsSync(join(dest, ".git"))).toBe(true);
    expect(await adapter.originUrl(dest)).toBe(url);
    expect(await adapter.originHead(dest)).toBe("trunk");
    expect(streamed).toContain("Cloning into");
  });

  test("a failed clone is a GitError with the git error, not the Cloning line", async () => {
    const dest = join(iso.root, "api");
    let streamed = "";
    const error = await createGit({
      interactive: false,
      env: env(),
      stderr: (text) => {
        streamed += text;
      },
    })
      .clone(pathToFileURL(join(iso.root, "missing.git")).href, dest)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GitError);
    expect(error).toMatchObject({ code: "git-failed", exitCode: 128 });
    expect((error as GitError).args.slice(0, 2)).toEqual(["clone", "--"]);
    expect((error as GitError).message).not.toContain("Cloning into");
    expect((error as GitError).message).toContain("failed: fatal:");
    expect(streamed).toContain("fatal:");
    expect(existsSync(dest)).toBe(false);
  });

  test("git missing from PATH is a GitError", async () => {
    const empty = join(iso.root, "empty");
    mkdirSync(empty);
    const error = await createGit({
      interactive: false,
      env: { ...env(), PATH: empty, Path: empty },
      stderr: () => {},
    })
      .clone("file:///x.git", join(iso.root, "x"))
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GitError);
  });
});

describe("createGit pull", () => {
  /** A clone of a new `api` origin in `<root>/api`, so `main` tracks `origin/main`. */
  function cloned(): { dir: string; origin: string } {
    const origin = makeRepos(join(iso.root, "up"), { api: {} }).api as string;
    const dir = join(root, "api");
    git(root, "clone", "--quiet", origin, "api");
    return { dir, origin };
  }

  test("fast-forwards the checked-out branch and streams all git output to stderr", async () => {
    const { dir, origin } = cloned();
    const head = pushCommit(origin);
    let streamed = "";
    const adapter = createGit({
      interactive: false,
      env: env(),
      stderr: (text) => {
        streamed += text;
      },
    });
    await adapter.pull(dir);
    expect(git(dir, "rev-parse", "HEAD").trim()).toBe(head);
    expect(git(dir, "branch", "--show-current")).toBe("main\n");
    // git prints the fetch to stderr and the merge summary to stdout.
    expect(streamed).toMatch(/main +-> origin\/main/);
    expect(streamed).toContain("Fast-forward");
    streamed = "";
    await adapter.pull(dir);
    expect(streamed).toContain("Already up to date.");
  });

  test("never rebases, also with pull.rebase=true: a diverged branch is a GitError and keeps its commit", async () => {
    const { dir, origin } = cloned();
    pushCommit(origin);
    git(dir, "config", "pull.rebase", "true");
    git(dir, "commit", "--quiet", "--allow-empty", "-m", "local");
    const local = git(dir, "rev-parse", "HEAD").trim();
    const error = await createGit({
      interactive: false,
      env: env(),
      stderr: () => {},
    })
      .pull(dir)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GitError);
    expect(error).toMatchObject({ code: "git-failed", exitCode: 128 });
    expect((error as GitError).args).toEqual([
      "-C",
      dir,
      "pull",
      "--ff-only",
      "--no-rebase",
    ]);
    expect((error as GitError).stderr).toContain(
      "Not possible to fast-forward",
    );
    expect(git(dir, "rev-parse", "HEAD").trim()).toBe(local);
  });
});

const CLEAN = { uncommitted: [], unpushed: [], stashes: 0 };

describe("createGit lossCheck", () => {
  test("a clean repo with every branch pushed loses nothing", async () => {
    makeRepos(root, { api: {} });
    const adapter = createGit({ interactive: false, env: env() });
    expect(await adapter.lossCheck(join(root, "api"))).toEqual(CLEAN);
  });

  test("lists changed, staged, renamed and untracked files, but not ignored ones", async () => {
    makeRepos(root, { api: {} });
    const repo = join(root, "api");
    writeFile(join(repo, ".gitignore"), "*.log\n");
    writeFile(join(repo, "old.txt"), "x");
    writeFile(join(repo, "tracked.txt"), "x");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "files");
    git(repo, "push", "--quiet", "origin", "main");
    writeFile(join(repo, "tracked.txt"), "changed");
    git(repo, "mv", "old.txt", "new name.txt");
    writeFile(join(repo, "staged.txt"), "x");
    git(repo, "add", "staged.txt");
    writeFile(join(repo, "notes ü.md"), "x");
    writeFile(join(repo, "debug.log"), "x");
    const result = await createGit({
      interactive: false,
      env: env(),
    }).lossCheck(repo);
    expect([...result.uncommitted].sort()).toEqual([
      "new name.txt",
      "notes ü.md",
      "staged.txt",
      "tracked.txt",
    ]);
    expect(result.unpushed).toEqual([]);
    expect(result.stashes).toBe(0);
  });

  test("lists each local branch with commits that are on no remote, with the count", async () => {
    makeRepos(root, { api: {} });
    const repo = join(root, "api");
    git(repo, "commit", "--quiet", "--allow-empty", "-m", "two");
    git(repo, "commit", "--quiet", "--allow-empty", "-m", "three");
    git(repo, "branch", "pushed", "origin/main");
    git(repo, "checkout", "--quiet", "-b", "feat");
    git(repo, "commit", "--quiet", "--allow-empty", "-m", "feat");
    git(repo, "checkout", "--quiet", "main");
    const result = await createGit({
      interactive: false,
      env: env(),
    }).lossCheck(repo);
    expect(result.unpushed).toEqual([
      { branch: "feat", count: 3 },
      { branch: "main", count: 2 },
    ]);
  });

  test("a repo with no remote: every commit of each branch is unpushed", async () => {
    makeRepos(root, { solo: { origin: false } });
    const result = await createGit({
      interactive: false,
      env: env(),
    }).lossCheck(join(root, "solo"));
    expect(result.unpushed).toEqual([{ branch: "main", count: 1 }]);
  });

  test("counts the stashes", async () => {
    makeRepos(root, { api: {} });
    const repo = join(root, "api");
    const adapter = createGit({ interactive: false, env: env() });
    writeFile(join(repo, "a.txt"), "x");
    git(repo, "stash", "push", "--quiet", "--include-untracked");
    expect((await adapter.lossCheck(repo)).stashes).toBe(1);
    writeFile(join(repo, "b.txt"), "x");
    git(repo, "stash", "push", "--quiet", "--include-untracked");
    expect(await adapter.lossCheck(repo)).toEqual({ ...CLEAN, stashes: 2 });
  });

  test("does not change the repo: the index stays as it is", async () => {
    makeRepos(root, { api: {} });
    const repo = join(root, "api");
    writeFile(join(repo, "a.txt"), "x");
    git(repo, "add", "a.txt");
    git(repo, "commit", "--quiet", "-m", "a");
    // A new mtime makes a plain `git status` refresh and rewrite the index.
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(repo, "a.txt"), later, later);
    const index = readFileSync(join(repo, ".git", "index"));
    await createGit({ interactive: false, env: env() }).lossCheck(repo);
    expect(readFileSync(join(repo, ".git", "index"))).toEqual(index);
  });

  test("repo config that hides untracked files or submodule changes is ignored", async () => {
    makeRepos(root, { api: {} });
    const repo = join(root, "api");
    git(repo, "config", "status.showUntrackedFiles", "no");
    git(repo, "config", "diff.ignoreSubmodules", "all");
    writeFile(join(repo, "new", "work.txt"), "x");
    const result = await createGit({
      interactive: false,
      env: env(),
    }).lossCheck(repo);
    expect(result.uncommitted).toEqual(["new/work.txt"]);
  });

  test("counts commits on a detached HEAD that no branch or remote has", async () => {
    makeRepos(root, { api: {} });
    const repo = join(root, "api");
    git(repo, "checkout", "--quiet", "--detach");
    git(repo, "commit", "--quiet", "--allow-empty", "-m", "detached");
    git(repo, "commit", "--quiet", "--allow-empty", "-m", "detached 2");
    const result = await createGit({
      interactive: false,
      env: env(),
    }).lossCheck(repo);
    expect(result.unpushed).toEqual([{ branch: "HEAD", count: 2 }]);
  });

  test("an unborn HEAD with no commits loses nothing", async () => {
    const repo = join(root, "fresh");
    mkdirSync(repo);
    git(repo, "init", "--quiet");
    const result = await createGit({
      interactive: false,
      env: env(),
    }).lossCheck(repo);
    expect(result).toEqual(CLEAN);
  });

  test("a file named like a branch does not confuse rev-list", async () => {
    makeRepos(root, { api: {} });
    const repo = join(root, "api");
    git(repo, "branch", "feat");
    writeFile(join(repo, "refs", "heads", "feat"), "x");
    writeFile(join(repo, "feat"), "x");
    writeFile(join(repo, "HEAD"), "x");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "files");
    git(repo, "push", "--quiet", "origin", "main", "feat");
    const result = await createGit({
      interactive: false,
      env: env(),
    }).lossCheck(repo);
    expect(result).toEqual(CLEAN);
  });

  test("a worktree rename (Y column R) lists the new path only", async () => {
    makeRepos(root, { api: {} });
    const repo = join(root, "api");
    writeFile(join(repo, "a.txt"), "hello world content\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "--quiet", "-m", "a");
    git(repo, "push", "--quiet", "origin", "main");
    renameSync(join(repo, "a.txt"), join(repo, "c.txt"));
    git(repo, "add", "--intent-to-add", "c.txt");
    const result = await createGit({
      interactive: false,
      env: env(),
    }).lossCheck(repo);
    expect(result.uncommitted).toEqual(["c.txt"]);
  });

  test("many untracked files do not overflow the output buffer", async () => {
    makeRepos(root, { api: {} });
    const repo = join(root, "api");
    const name = "x".repeat(200);
    for (let n = 0; n < 6000; n += 1) {
      writeFileSync(join(repo, `${name}-${n}`), "");
    }
    const result = await createGit({
      interactive: false,
      env: env(),
    }).lossCheck(repo);
    expect(result.uncommitted).toHaveLength(6000);
  }, 30_000);

  test("a folder that is not a repo fails with a GitError", async () => {
    const dir = join(iso.root, "plain");
    mkdirSync(dir);
    const error = await createGit({ interactive: false, env: env() })
      .lossCheck(dir)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GitError);
  });

  test("an aborted signal stops it: GitError with exitCode null", async () => {
    makeRepos(root, { api: {} });
    const error = await createGit({ interactive: false, env: env() })
      .lossCheck(join(root, "api"), { signal: AbortSignal.abort() })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GitError);
    expect(error).toMatchObject({ exitCode: null });
  });
});

/** A fake `git` that logs each call and prints its env for any command but `version`. */
function fakeGit(version: string): { env: NodeJS.ProcessEnv; log: string } {
  const bin = join(iso.root, "fake-bin");
  const log = join(iso.root, "fake-git.log");
  const script = writeFile(
    join(bin, "git"),
    [
      "#!/bin/sh",
      `echo "$*" >> "${log}"`,
      `if [ "$1" = version ]; then echo "git version ${version}"; exit 0; fi`,
      'printf "%s|" "LC_ALL=$LC_ALL" "GIT_TERMINAL_PROMPT=$GIT_TERMINAL_PROMPT" "GCM_INTERACTIVE=$GCM_INTERACTIVE" "GIT_SSH_COMMAND=$GIT_SSH_COMMAND"',
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  return {
    env: { ...env(), PATH: [bin, process.env.PATH].join(delimiter) },
    log,
  };
}

describe("parseVersion", () => {
  test("gives the version from `git version`, with any suffix", () => {
    expect(parseVersion("git version 2.27.0\n")).toBe("2.27.0");
    expect(parseVersion("git version 2.45.1.windows.1\n")).toBe(
      "2.45.1.windows.1",
    );
    expect(parseVersion("git version 3.0.0")).toBe("3.0.0");
  });

  test("below 2.27 is git-too-old with the found version and an upgrade hint", () => {
    for (const out of ["git version 2.26.9", "git version 1.99.0"]) {
      let thrown: unknown;
      try {
        parseVersion(out);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(XrError);
      expect(thrown).toMatchObject({ code: "git-too-old" });
      expect((thrown as XrError).message).toContain(out.slice(12));
      expect((thrown as XrError).hint).toContain("Upgrade git");
    }
  });

  test("text that is not a git version is git-failed", () => {
    expect(() => parseVersion("hello")).toThrow(GitError);
  });
});

describe.skipIf(process.platform === "win32")(
  "createGit with a fake git",
  () => {
    test("git older than 2.27 fails with git-too-old, the found version and an upgrade hint", async () => {
      const fake = fakeGit("2.26.9");
      const error = await createGit({ interactive: false, env: fake.env })
        .originUrl(root)
        .catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(XrError);
      expect(error).toMatchObject({ code: "git-too-old" });
      expect((error as XrError).message).toContain("2.26.9");
      expect((error as XrError).hint).toContain("2.27");
    });

    test("checks the version once, at the first call", async () => {
      const fake = fakeGit("2.27.0.windows.1");
      const adapter = createGit({ interactive: false, env: fake.env });
      expect(await adapter.version()).toBe("2.27.0.windows.1");
      await adapter.originUrl(root);
      await adapter.originHead(root);
      const calls = readFileSync(fake.log, "utf8").trim().split("\n");
      expect(calls.filter((call) => call === "version")).toHaveLength(1);
      expect(calls).toHaveLength(3);
    });

    test("an unreadable version fails with git-failed", async () => {
      const fake = fakeGit("unknown");
      const error = await createGit({ interactive: false, env: fake.env })
        .version()
        .catch((thrown: unknown) => thrown);
      expect(error).toMatchObject({ code: "git-failed" });
    });

    test("not interactive: LC_ALL=C, no prompts and ssh BatchMode", async () => {
      const fake = fakeGit("2.40.0");
      const out = await createGit({
        interactive: false,
        env: { ...fake.env, GIT_SSH_COMMAND: undefined, LC_ALL: "de_DE" },
      }).originUrl(root);
      expect(out).toBe(
        "LC_ALL=C|GIT_TERMINAL_PROMPT=0|GCM_INTERACTIVE=never|GIT_SSH_COMMAND=ssh -o BatchMode=yes|",
      );
    });

    test("a GIT_SSH_COMMAND set by the user is kept", async () => {
      const fake = fakeGit("2.40.0");
      const out = await createGit({
        interactive: false,
        env: { ...fake.env, GIT_SSH_COMMAND: "ssh -i key" },
      }).originUrl(root);
      expect(out).toContain("GIT_SSH_COMMAND=ssh -i key|");
    });

    test("GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE from the caller env are dropped", async () => {
      const fake = fakeGit("2.40.0");
      const bin = join(iso.root, "fake-bin");
      writeFile(
        join(bin, "git"),
        [
          "#!/bin/sh",
          'if [ "$1" = version ]; then echo "git version 2.40.0"; exit 0; fi',
          'printf "%s|" "GIT_DIR=$GIT_DIR" "GIT_WORK_TREE=$GIT_WORK_TREE" "GIT_INDEX_FILE=$GIT_INDEX_FILE"',
          "",
        ].join("\n"),
      );
      const out = await createGit({
        interactive: false,
        env: {
          ...fake.env,
          GIT_DIR: "/x/.git",
          GIT_WORK_TREE: "/x",
          GIT_INDEX_FILE: "/x/index",
        },
      }).originUrl(root);
      expect(out).toBe("GIT_DIR=|GIT_WORK_TREE=|GIT_INDEX_FILE=|");
    });

    test("an aborted signal stops git: GitError with exitCode null", async () => {
      const bin = join(iso.root, "slow-bin");
      const script = writeFile(
        join(bin, "git"),
        [
          "#!/bin/sh",
          'if [ "$1" = version ]; then echo "git version 2.40.0"; exit 0; fi',
          "exec sleep 10",
          "",
        ].join("\n"),
      );
      chmodSync(script, 0o755);
      const adapter = createGit({
        interactive: false,
        env: { ...env(), PATH: [bin, process.env.PATH].join(delimiter) },
      });
      const controller = new AbortController();
      const started = Date.now();
      const call = adapter
        .originUrl(root, { signal: controller.signal })
        .catch((thrown: unknown) => thrown);
      setTimeout(() => controller.abort(), 200);
      const error = await call;
      expect(Date.now() - started).toBeLessThan(5000);
      expect(error).toBeInstanceOf(GitError);
      expect(error).toMatchObject({ code: "git-failed", exitCode: null });
      const head = await adapter
        .originHead(root, { signal: AbortSignal.abort() })
        .catch((thrown: unknown) => thrown);
      expect(head).toMatchObject({ exitCode: null });
    });

    test("clone runs `git clone -- <url> <dest>`, with --progress only when asked", async () => {
      const fake = fakeGit("2.40.0");
      const quiet = createGit({
        interactive: false,
        env: fake.env,
        stderr: () => {},
      });
      await quiet.clone("git@example.com:acme/api.git", join(root, "api"));
      const loud = createGit({
        interactive: false,
        env: fake.env,
        stderr: () => {},
        progress: true,
      });
      await loud.clone("file:///o/web.git", join(root, "web"));
      const calls = readFileSync(fake.log, "utf8").trim().split("\n");
      expect(calls).toEqual([
        "version",
        `clone -- git@example.com:acme/api.git ${join(root, "api")}`,
        "version",
        `clone --progress -- file:///o/web.git ${join(root, "web")}`,
      ]);
    });

    test("a failed clone's GitError leaves out the Cloning line and progress lines", async () => {
      const bin = join(iso.root, "noisy-bin");
      const script = writeFile(
        join(bin, "git"),
        [
          "#!/bin/sh",
          'if [ "$1" = version ]; then echo "git version 2.40.0"; exit 0; fi',
          "printf \"Cloning into 'x'...\\n\" >&2",
          "printf 'remote: Counting objects:  50%% (1/2)\\rremote: Counting objects: 100%% (2/2), done.\\n' >&2",
          "printf 'Receiving objects:  45%% (9/20)\\rReceiving objects: 100%% (20/20), 1.2 KiB | 1.2 MiB/s, done.\\n' >&2",
          "echo 'fatal: early EOF' >&2",
          "exit 128",
          "",
        ].join("\n"),
      );
      chmodSync(script, 0o755);
      const error = await createGit({
        interactive: false,
        env: { ...env(), PATH: [bin, process.env.PATH].join(delimiter) },
        stderr: () => {},
      })
        .clone("file:///o/api.git", join(root, "api"))
        .catch((thrown: unknown) => thrown);
      expect(error).toMatchObject({
        exitCode: 128,
        stderr: "fatal: early EOF",
      });
      expect((error as GitError).message).toEndWith("failed: fatal: early EOF");
    });

    test("clone checks the git version first", async () => {
      const fake = fakeGit("2.26.0");
      const error = await createGit({
        interactive: false,
        env: fake.env,
        stderr: () => {},
      })
        .clone("file:///o/api.git", join(root, "api"))
        .catch((thrown: unknown) => thrown);
      expect(error).toMatchObject({ code: "git-too-old" });
    });

    test("an aborted signal stops git clone: GitError with exitCode null", async () => {
      const bin = join(iso.root, "slow-bin");
      const script = writeFile(
        join(bin, "git"),
        [
          "#!/bin/sh",
          'if [ "$1" = version ]; then echo "git version 2.40.0"; exit 0; fi',
          "echo \"Cloning into 'x'...\" >&2",
          "exec sleep 10",
          "",
        ].join("\n"),
      );
      chmodSync(script, 0o755);
      let streamed = "";
      const controller = new AbortController();
      const adapter = createGit({
        interactive: false,
        env: { ...env(), PATH: [bin, process.env.PATH].join(delimiter) },
        // Stop git once it has started and written its first line.
        stderr: (text) => {
          streamed += text;
          controller.abort();
        },
      });
      const started = Date.now();
      const error = await adapter
        .clone("file:///o/api.git", join(root, "api"), {
          signal: controller.signal,
        })
        .catch((thrown: unknown) => thrown);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(error).toBeInstanceOf(GitError);
      expect(error).toMatchObject({ code: "git-failed", exitCode: null });
      expect(streamed).toContain("Cloning into");
      const early = await adapter
        .clone("file:///o/api.git", join(root, "web"), {
          signal: AbortSignal.abort(),
        })
        .catch((thrown: unknown) => thrown);
      expect(early).toMatchObject({ exitCode: null });
    });

    test("pull runs `git -C <dir> pull --ff-only --no-rebase`, with --progress only when asked", async () => {
      const fake = fakeGit("2.40.0");
      await createGit({
        interactive: false,
        env: fake.env,
        stderr: () => {},
      }).pull(join(root, "api"));
      await createGit({
        interactive: false,
        env: fake.env,
        stderr: () => {},
        progress: true,
      }).pull(join(root, "web"));
      const calls = readFileSync(fake.log, "utf8").trim().split("\n");
      expect(calls).toEqual([
        "version",
        `-C ${join(root, "api")} pull --ff-only --no-rebase`,
        "version",
        `-C ${join(root, "web")} pull --ff-only --no-rebase --progress`,
      ]);
    });

    test("pull checks the git version first", async () => {
      const fake = fakeGit("2.26.0");
      const error = await createGit({
        interactive: false,
        env: fake.env,
        stderr: () => {},
      })
        .pull(join(root, "api"))
        .catch((thrown: unknown) => thrown);
      expect(error).toMatchObject({ code: "git-too-old" });
    });

    test("a failed pull's GitError leaves out progress lines and the fetch report", async () => {
      const bin = join(iso.root, "noisy-bin");
      const script = writeFile(
        join(bin, "git"),
        [
          "#!/bin/sh",
          'if [ "$1" = version ]; then echo "git version 2.40.0"; exit 0; fi',
          "printf 'remote: Counting objects:  50%% (1/2)\\rremote: Counting objects: 100%% (2/2), done.\\n' >&2",
          "printf 'Unpacking objects:  45%% (9/20)\\rUnpacking objects: 100%% (20/20), done.\\n' >&2",
          "echo 'From /o/api' >&2",
          "echo '   ab0d9f1..6b49583  main       -> origin/main' >&2",
          "echo ' * [new branch]      feat       -> origin/feat' >&2",
          "echo ' ! [rejected]        v1         -> v1  (would clobber existing tag)' >&2",
          "echo 'hint: a hint' >&2",
          "echo 'fatal: Not possible to fast-forward, aborting.' >&2",
          "exit 128",
          "",
        ].join("\n"),
      );
      chmodSync(script, 0o755);
      let streamed = "";
      const error = await createGit({
        interactive: false,
        env: { ...env(), PATH: [bin, process.env.PATH].join(delimiter) },
        stderr: (text) => {
          streamed += text;
        },
      })
        .pull(join(root, "api"))
        .catch((thrown: unknown) => thrown);
      expect(error).toMatchObject({
        exitCode: 128,
        stderr:
          " ! [rejected]        v1         -> v1  (would clobber existing tag)\nhint: a hint\nfatal: Not possible to fast-forward, aborting.",
      });
      expect(streamed).toContain("Unpacking objects");
      expect(streamed).toContain("From /o/api");
    });

    test("an aborted signal stops git pull: GitError with exitCode null", async () => {
      const bin = join(iso.root, "slow-bin");
      const script = writeFile(
        join(bin, "git"),
        [
          "#!/bin/sh",
          'if [ "$1" = version ]; then echo "git version 2.40.0"; exit 0; fi',
          "echo 'From /o/api' >&2",
          "exec sleep 10",
          "",
        ].join("\n"),
      );
      chmodSync(script, 0o755);
      const controller = new AbortController();
      const adapter = createGit({
        interactive: false,
        env: { ...env(), PATH: [bin, process.env.PATH].join(delimiter) },
        stderr: () => controller.abort(),
      });
      const started = Date.now();
      const error = await adapter
        .pull(join(root, "api"), { signal: controller.signal })
        .catch((thrown: unknown) => thrown);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(error).toBeInstanceOf(GitError);
      expect(error).toMatchObject({ code: "git-failed", exitCode: null });
      const early = await adapter
        .pull(join(root, "web"), { signal: AbortSignal.abort() })
        .catch((thrown: unknown) => thrown);
      expect(early).toMatchObject({ exitCode: null });
    });

    test("interactive: only LC_ALL=C is set", async () => {
      const fake = fakeGit("2.40.0");
      const out = await createGit({
        interactive: true,
        env: {
          ...fake.env,
          GIT_SSH_COMMAND: undefined,
          GIT_TERMINAL_PROMPT: undefined,
          GCM_INTERACTIVE: undefined,
        },
      }).originUrl(root);
      expect(out).toBe(
        "LC_ALL=C|GIT_TERMINAL_PROMPT=|GCM_INTERACTIVE=|GIT_SSH_COMMAND=|",
      );
    });
  },
);
