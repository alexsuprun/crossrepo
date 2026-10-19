import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import * as fsAdapter from "../../../src/adapters/fs/index.ts";
import * as gitAdapter from "../../../src/adapters/git/index.ts";
import { main } from "../../../src/cli/index.ts";
import { GitError } from "../../../src/errors/index.ts";
import { withFault } from "../../helpers/faults.ts";
import { git, makeRepos } from "../../helpers/git.ts";
import {
  type FakeInterrupts,
  fakeInterrupts,
} from "../../helpers/interrupts.ts";
import { type Isolation, isolate, writeFile } from "../../helpers/isolate.ts";

let iso: Isolation;
let codebase: string;
let configFile: string;
let localFile: string;
let lockFile: string;
let spies: { mockRestore(): void }[];
let interrupts: FakeInterrupts;
/** Bare origins outside the codebase, as `file://` URLs. */
let urls: Record<string, string>;

const CLONE = ["codebase", "clone"];

beforeEach(() => {
  iso = isolate();
  codebase = join(iso.root, "shop");
  mkdirSync(codebase);
  configFile = join(codebase, ".crossrepo", "config.yaml");
  localFile = join(codebase, ".crossrepo", "config.local.yaml");
  lockFile = join(codebase, ".crossrepo", "xr.lock");
  spies = [];
  interrupts = fakeInterrupts();
  const remotes = makeRepos(join(iso.root, "upstream"), {
    api: {},
    web: { branch: "trunk" },
    docs: {},
  });
  urls = Object.fromEntries(
    Object.entries(remotes).map(([name, path]) => [
      name,
      pathToFileURL(path as string).href,
    ]),
  );
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  iso.restore();
});

/** Writes the codebase config with these repos, in this order. A missing remote is left out. */
function config(repos: Record<string, string | undefined>): string {
  const lines = Object.entries(repos).flatMap(([name, remote]) => [
    `  ${name}:`,
    ...(remote === undefined ? [] : [`    remote: ${remote}`]),
    "    default-branch: main",
  ]);
  const text = lines.length ? `repos:\n${lines.join("\n")}\n` : "repos: {}\n";
  writeFile(configFile, text);
  return text;
}

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
    tty = false,
  }: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    tty?: boolean;
  } = {},
) {
  let stdout = "";
  let stderr = "";
  const code = await main({
    version: "1.2.3",
    argv,
    env,
    isTTY: { stdin: false, stdout: tty, stderr: tty },
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

function fakeFs(wrap: (fs: fsAdapter.Fs) => fsAdapter.Fs) {
  const real = fsAdapter.createFs;
  spies.push(
    spyOn(fsAdapter, "createFs").mockImplementation((platform) =>
      wrap(real(platform)),
    ),
  );
}

function fakeGit(wrap: (git: gitAdapter.Git) => gitAdapter.Git) {
  const real = gitAdapter.createGit;
  spies.push(
    spyOn(gitAdapter, "createGit").mockImplementation((options) =>
      wrap(real(options)),
    ),
  );
}

/** Counts the calls of `clone` and `version`. */
function countGit() {
  const calls = { clone: 0, version: 0 };
  fakeGit((git) => ({
    ...git,
    async version() {
      calls.version += 1;
      return git.version();
    },
    async clone(...args) {
      calls.clone += 1;
      return git.clone(...args);
    },
  }));
  return calls;
}

/** Fires `times` Ctrl-C at the first stderr text of the `nth` clone, so the signal stops a live git. */
function interruptGit(nth = 1, times = 1) {
  const real = gitAdapter.createGit;
  let clones = 0;
  let fired = false;
  spies.push(
    spyOn(gitAdapter, "createGit").mockImplementation((options) => {
      const inner = real({
        ...options,
        stderr(text) {
          options.stderr?.(text);
          if (fired || clones !== nth) return;
          fired = true;
          for (let i = 0; i < times; i += 1) interrupts.fire();
        },
      });
      return {
        ...inner,
        clone(...args) {
          clones += 1;
          return inner.clone(...args);
        },
      };
    }),
  );
}

const ok = (repo: string) => ({ repo, status: "ok" });
const stopped = (repo: string) => ({
  repo,
  status: "skipped",
  message: "interrupted",
});

describe("xr codebase clone", () => {
  test("--json clones every missing repo in config order and prints one JSON object", async () => {
    const before = config({ web: urls.web, api: urls.api });
    const result = await run(["--json", ...CLONE]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      `${JSON.stringify({ ok: true, warnings: [], repos: [ok("web"), ok("api")] })}\n`,
    );
    expect(result.stderr.indexOf("✓ web")).toBeLessThan(
      result.stderr.indexOf("✓ api"),
    );
    expect(result.stderr).toContain("Cloning into");
    expect(git(join(codebase, "web"), "remote", "get-url", "origin")).toBe(
      `${urls.web}\n`,
    );
    // A plain clone checks out the branch of origin/HEAD.
    expect(git(join(codebase, "web"), "branch", "--show-current")).toBe(
      "trunk\n",
    );
    expect(existsSync(join(codebase, "api", ".git"))).toBe(true);
    expect(readFileSync(configFile, "utf8")).toBe(before);
    expect(existsSync(join(codebase, "AGENTS.md"))).toBe(false);
    expect(existsSync(lockFile)).toBe(false);
    expect(interrupts.listening).toBe(0);
  });

  test("text mode: git output and one line per repo on stderr, the repo lines on stdout", async () => {
    config({ api: urls.api, web: urls.web });
    mkdirSync(join(codebase, "web", ".git"), { recursive: true });
    const result = await run(CLONE);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("✓ api\n– web: already on disk\n");
    expect(result.stderr).toContain("Cloning into");
    expect(result.stderr).toEndWith("✓ api\n– web: already on disk\n");
  });

  test("text mode in a terminal: the repo lines show once, on stderr only", async () => {
    config({ api: urls.api, web: urls.web });
    mkdirSync(join(codebase, "api", ".git"), { recursive: true });
    mkdirSync(join(codebase, "web", ".git"), { recursive: true });
    const result = await run(CLONE, { tty: true });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("api");
    expect(result.stderr).toContain("web");
  });

  test("a local remote wins over the codebase one, and is passed as written", async () => {
    config({ api: "/nowhere/api.git" });
    writeFile(localFile, `repos:\n  api:\n    remote: ${urls.docs}\n`);
    const result = await json(CLONE);
    expect(result.code).toBe(0);
    expect(git(join(codebase, "api"), "remote", "get-url", "origin")).toBe(
      `${urls.docs}\n`,
    );
  });

  test("a repo whose .git exists, as a folder or a file: skipped, git not run", async () => {
    config({ api: urls.api, web: urls.web });
    mkdirSync(join(codebase, "api", ".git"), { recursive: true });
    writeFile(join(codebase, "web", ".git"), "gitdir: /elsewhere\n");
    const calls = countGit();
    const result = await json(CLONE);
    expect(result.code).toBe(0);
    expect(result.data.repos).toEqual([
      { repo: "api", status: "skipped", message: "already on disk" },
      { repo: "web", status: "skipped", message: "already on disk" },
    ]);
    expect(calls).toEqual({ clone: 0, version: 0 });
  });

  test("git version is checked once for many clones", async () => {
    config({ api: urls.api, web: urls.web });
    const calls = countGit();
    await json(CLONE);
    expect(calls).toEqual({ clone: 2, version: 1 });
  });

  test("a folder with no .git: failed with a hint, never touched; the others still run", async () => {
    config({ api: urls.api, web: urls.web });
    const folder = join(codebase, "api");
    writeFile(join(folder, "notes.txt"), "mine");
    const result = await json(CLONE);
    expect(result.code).toBe(1);
    expect(result.data).toEqual({
      ok: false,
      warnings: [],
      repos: [
        {
          repo: "api",
          status: "failed",
          message: "folder has no .git",
          hint: `Move or delete ${folder}, then run \`xr codebase clone\` again.`,
        },
        ok("web"),
      ],
      error: {
        code: "repos-failed",
        message: "1 of 2 repos failed: api.",
        hint: "Fix each failed repo, then run `xr codebase clone` again.",
      },
    });
    expect(readFileSync(join(folder, "notes.txt"), "utf8")).toBe("mine");
    expect(existsSync(join(folder, ".git"))).toBe(false);
    expect(existsSync(join(codebase, "web", ".git"))).toBe(true);
    expect(existsSync(lockFile)).toBe(false);
  });

  test("text mode and a failure: stdout is empty, the repos and the error go to stderr", async () => {
    config({ api: undefined });
    const result = await run(CLONE);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("✗ api: no remote in the config\n");
    expect(result.stderr).toEndWith(
      "error: 1 of 1 repo failed: api.\nFix each failed repo, then run `xr codebase clone` again.\n",
    );
  });

  test("no remote: failed with a hint to add one, git not run", async () => {
    config({ api: undefined, web: urls.web });
    const calls = countGit();
    const result = await json(CLONE);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("repos-failed");
    expect(result.data.repos).toEqual([
      {
        repo: "api",
        status: "failed",
        message: "no remote in the config",
        hint: "Add `remote` for `api` in .crossrepo/config.yaml or .crossrepo/config.local.yaml.",
      },
      ok("web"),
    ]);
    expect(calls.clone).toBe(1);
  });

  test("a clone that fails: no folder left, the first git error line, the others still run", async () => {
    const bad = pathToFileURL(join(iso.root, "missing.git")).href;
    config({ api: bad, web: urls.web });
    const result = await json(CLONE);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("repos-failed");
    const [api, web] = result.data.repos;
    expect(api.status).toBe("failed");
    expect(api.message).toStartWith("fatal:");
    expect(api.message).not.toContain("\n");
    expect(api.hint).toBeUndefined();
    expect(web).toEqual(ok("web"));
    expect(existsSync(join(codebase, "api"))).toBe(false);
    expect(existsSync(lockFile)).toBe(false);
  });

  test("a clone that fails after making its folder: the folder is deleted", async () => {
    config({ api: urls.api });
    fakeGit((git) => ({
      ...git,
      async clone(_url, dest) {
        writeFile(join(dest, "partial"), "x");
        throw new GitError({
          args: ["clone"],
          exitCode: 128,
          stderr: "fatal: first\nsecond",
        });
      },
    }));
    const result = await json(CLONE);
    expect(result.data.repos).toEqual([
      { repo: "api", status: "failed", message: "fatal: first" },
    ]);
    expect(existsSync(join(codebase, "api"))).toBe(false);
  });

  test("a failed clone with no stderr: the message of the error", async () => {
    config({ api: urls.api });
    fakeGit((git) => ({
      ...git,
      async clone() {
        throw new GitError({ args: ["clone"], exitCode: 128, stderr: "" });
      },
    }));
    const result = await json(CLONE);
    expect(result.data.repos[0].message).toBe(
      "`git clone` failed with exit code 128.",
    );
  });

  test("the partial folder cannot be deleted: failed with the git message and an rm hint", async () => {
    config({ api: urls.api });
    const target = join(codebase, "api");
    fakeGit((git) => ({
      ...git,
      async clone(_url, dest) {
        writeFile(join(dest, "partial"), "x");
        throw new GitError({
          args: ["clone"],
          exitCode: 128,
          stderr: "fatal: x",
        });
      },
    }));
    fakeFs((fs) => withFault(fs, "remove", 1));
    const result = await json(CLONE);
    expect(result.code).toBe(1);
    expect(result.data.repos).toEqual([
      {
        repo: "api",
        status: "failed",
        message: "fatal: x",
        hint: `Delete the partial folder with \`rm -r "${target}"\`, then run \`xr codebase clone\` again.`,
      },
    ]);
    expect(existsSync(target)).toBe(true);
  });

  test("a folder made by another program before the clone is kept", async () => {
    config({ api: urls.api });
    const target = join(codebase, "api");
    fakeGit((git) => ({
      ...git,
      // Runs after the folder checks and before the clone.
      async version() {
        writeFile(join(target, "theirs"), "x");
        return git.version();
      },
      async clone() {
        throw new GitError({
          args: ["clone"],
          exitCode: 128,
          stderr: "fatal: destination path 'api' already exists",
        });
      },
    }));
    const result = await json(CLONE);
    expect(result.data.repos[0].status).toBe("failed");
    expect(readFileSync(join(target, "theirs"), "utf8")).toBe("x");
  });

  test.skipIf(process.platform === "win32")(
    "git older than 2.27: git-too-old, nothing cloned, the lock is released",
    async () => {
      config({ api: urls.api });
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
      const result = await json(CLONE, { env });
      expect(result.code).toBe(1);
      expect(result.data.error.code).toBe("git-too-old");
      expect(existsSync(join(codebase, "api"))).toBe(false);
      expect(existsSync(lockFile)).toBe(false);
    },
  );

  test("an empty codebase: no repo lines, repos: [], exit 0", async () => {
    config({});
    const result = await json(CLONE);
    expect(result.code).toBe(0);
    expect(result.data).toEqual({ ok: true, warnings: [], repos: [] });
    expect(result.stderr).toBe("");
    const text = await run(CLONE);
    expect(text).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  test("not a codebase: not-a-codebase, no lock", async () => {
    const result = await json(CLONE);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("not-a-codebase");
    expect(existsSync(join(codebase, ".crossrepo"))).toBe(false);
  });

  test("a project folder: not-a-codebase", async () => {
    config({ api: urls.api });
    const project = join(codebase, ".projects", "feat");
    writeFile(join(project, ".crossrepo", "project.yaml"), "codebase: ../..\n");
    const result = await json(CLONE, { cwd: project });
    expect(result.data.error.code).toBe("not-a-codebase");
    expect(existsSync(join(codebase, "api"))).toBe(false);
  });

  test("a lock held by a running process: lock-held, nothing cloned", async () => {
    config({ api: urls.api });
    writeFile(lockFile, `${process.ppid}\n`);
    const result = await json(CLONE);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("lock-held");
    expect(result.data.repos).toBeUndefined();
    expect(existsSync(join(codebase, "api"))).toBe(false);
    expect(readFileSync(lockFile, "utf8")).toBe(`${process.ppid}\n`);
  });

  test("an argument or an own option: usage, exit 2", async () => {
    config({ api: urls.api });
    for (const extra of ["api", "--force"]) {
      const result = await json([...CLONE, extra]);
      expect(result.code).toBe(2);
      expect(result.data.error.code).toBe("usage");
    }
    expect(existsSync(join(codebase, "api"))).toBe(false);
  });

  test("xr codebase --help lists clone", async () => {
    const result = await run(["codebase", "--help"]);
    expect(result.stdout).toContain("clone");
  });
});

describe("xr codebase clone Ctrl-C", () => {
  test("during a clone: git stops, its folder is deleted, it and the rest are interrupted, exit 130", async () => {
    config({ api: urls.api, web: urls.web, docs: urls.docs });
    interruptGit(2);
    const result = await json(CLONE);
    expect(result.code).toBe(130);
    expect(result.data).toEqual({
      ok: false,
      warnings: [],
      repos: [ok("api"), stopped("web"), stopped("docs")],
      error: { code: "interrupted", message: "Stopped by Ctrl-C." },
    });
    expect(existsSync(join(codebase, "api", ".git"))).toBe(true);
    expect(existsSync(join(codebase, "web"))).toBe(false);
    expect(existsSync(join(codebase, "docs"))).toBe(false);
    expect(existsSync(lockFile)).toBe(false);
    expect(interrupts.listening).toBe(0);
  });

  test("the partial folder cannot be deleted: a leftovers block with rm -r", async () => {
    config({ api: urls.api });
    interruptGit();
    fakeFs((fs) => withFault(fs, "remove", 1));
    const result = await json(CLONE);
    const target = join(codebase, "api");
    expect(result.code).toBe(130);
    expect(result.data.repos).toEqual([stopped("api")]);
    expect(result.data.error).toEqual({
      code: "interrupted",
      message: "Stopped by Ctrl-C.",
      details: {
        leftovers: [
          { what: "partial clone", path: target, command: `rm -r "${target}"` },
        ],
      },
    });
    expect(existsSync(lockFile)).toBe(false);
    expect(interrupts.listening).toBe(0);
  });

  test("a second Ctrl-C: exit 130 at once, the lock file stays", async () => {
    config({ api: urls.api, web: urls.web });
    let finish: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    fakeGit((git) => ({
      ...git,
      clone(_url, _dest, options) {
        interrupts.fire();
        interrupts.fire();
        return new Promise((_, reject) => {
          options?.signal?.addEventListener("abort", () => {
            setTimeout(() => {
              finish();
              reject(new Error("stopped"));
            }, 0);
          });
          if (options?.signal?.aborted) {
            setTimeout(() => {
              finish();
              reject(new Error("stopped"));
            }, 0);
          }
        });
      },
    }));
    const result = await json(CLONE);
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
