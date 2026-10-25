import { execFile, spawn } from "node:child_process";
import { resolve } from "node:path";
import { GitError, XrError } from "../../errors/index.ts";

/** Options of every git call. An aborted `signal` stops git: `GitError` with `exitCode: null`. */
export interface GitCallOptions {
  signal?: AbortSignal;
}

/** Named git calls, as `ctx.git`. There is no generic `run`, `commit` or `add`. */
export interface Git {
  /** The version from `git version`, such as `2.45.1` or `2.45.1.windows.1`. */
  version(): Promise<string>;
  /** The raw `remote.origin.url` of the repo at `dir` (no `insteadOf`), or `undefined`. */
  originUrl(dir: string, options?: GitCallOptions): Promise<string | undefined>;
  /** The branch `origin/HEAD` points to, without `origin/`, or `undefined` when it is not set. */
  originHead(
    dir: string,
    options?: GitCallOptions,
  ): Promise<string | undefined>;
  /**
   * `git clone -- <url> <dest>`, with the URL as given (AD-6). git's stderr goes
   * to the `stderr` option as it comes; a failure is a `GitError` with its end.
   */
  clone(url: string, dest: string, options?: GitCallOptions): Promise<void>;
  /**
   * `git -C <dir> pull --ff-only --no-rebase` on the checked-out branch, from its
   * upstream: it never rebases or makes a merge commit (D35). git's stderr goes
   * to the `stderr` option as it comes; a failure is a `GitError` with its end.
   */
  pull(dir: string, options?: GitCallOptions): Promise<void>;
  /**
   * What a delete of the repo at `dir` would lose (D45). Reads only: it never
   * changes the repo, not even the index.
   */
  lossCheck(dir: string, options?: GitCallOptions): Promise<Loss>;
  /**
   * `git -C <dir> fetch origin`. git's output goes to the `stderr` option as it
   * comes; a failure is a `GitError` with its end.
   */
  fetch(dir: string, options?: GitCallOptions): Promise<void>;
  /** `git worktree list --porcelain`: each worktree, the main one first, with its branch when one is checked out. */
  worktreeList(dir: string, options?: GitCallOptions): Promise<Worktree[]>;
  /** `refs/heads/<branch>` exists. */
  localBranchExists(
    dir: string,
    branch: string,
    options?: GitCallOptions,
  ): Promise<boolean>;
  /** `refs/remotes/origin/<branch>` exists. */
  remoteBranchExists(
    dir: string,
    branch: string,
    options?: GitCallOptions,
  ): Promise<boolean>;
  /**
   * `git worktree add` at `path`, never with `--force`: `local` checks out the
   * branch, `tracking` makes it with `--track` from `startPoint`, and `new`
   * makes it with `--no-track` from `startPoint`.
   */
  worktreeAdd(
    dir: string,
    path: string,
    add: WorktreeAdd,
    options?: GitCallOptions,
  ): Promise<void>;
  /** `git worktree remove --force <path>`. */
  worktreeRemove(
    dir: string,
    path: string,
    options?: GitCallOptions,
  ): Promise<void>;
  /** `git worktree prune`. */
  worktreePrune(dir: string, options?: GitCallOptions): Promise<void>;
  /** `git branch -d <branch>`, or `-D` with `force`. */
  branchDelete(
    dir: string,
    branch: string,
    options: GitCallOptions & { force: boolean },
  ): Promise<void>;
}

/** One worktree of a repo. */
export interface Worktree {
  path: string;
  /** Absent for a detached HEAD or a bare repo. */
  branch?: string;
}

/** How `worktreeAdd` gets its branch. */
export interface WorktreeAdd {
  branch: string;
  source: "local" | "tracking" | "new";
  /** For `tracking` and `new`: the commit the new branch starts at, such as `origin/main`. */
  startPoint?: string;
}

/** Work that is only in one repo folder. */
export interface Loss {
  /** Changed, staged and untracked files that are not ignored, as git gives them. */
  uncommitted: string[];
  /** Local branches with commits that are on no remote, by branch name. */
  unpushed: { branch: string; count: number }[];
  stashes: number;
}

export interface CreateGitOptions {
  /** When false, git may never wait for a password or a prompt. */
  interactive: boolean;
  env: Readonly<Record<string, string | undefined>>;
  /** Gets git's live stderr of `clone` and `pull`. Default: the process stderr. */
  stderr?: (text: string) => void;
  /** Adds `--progress` to `clone` and `pull`; set it only when the process stderr is a TTY. */
  progress?: boolean;
}

const MIN_VERSION = [2, 27] as const;

/** Environment variables that would point git at another repo than `-C`. */
const REPO_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"];

interface Result {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** The most stderr a `clone` or `pull` keeps for its `GitError`, from the end. */
const KEPT_STDERR = 8192;

/** Builds `ctx.git`. The first call of any method checks that git is 2.27 or newer. */
export function createGit({
  interactive,
  env,
  stderr = (text) => process.stderr.write(text),
  progress = false,
}: CreateGitOptions): Git {
  const gitEnv = buildEnv(env, interactive);

  async function exec(
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<Result> {
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        args,
        // `status -z` of a repo with many untracked files passes the 1 MB default.
        {
          env: gitEnv,
          encoding: "utf8",
          windowsHide: true,
          signal,
          maxBuffer: Number.POSITIVE_INFINITY,
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ exitCode: 0, stdout, stderr });
            return;
          }
          const code = (error as { code?: unknown }).code;
          if (typeof code === "number") {
            resolve({ exitCode: code, stdout, stderr });
            return;
          }
          reject(
            new GitError({
              args,
              exitCode: null,
              stderr:
                code === "ENOENT"
                  ? "git was not found on PATH. Install git 2.27 or newer."
                  : error.message,
            }),
          );
        },
      );
    });
  }

  /**
   * Runs git with stderr streamed to `stderr`, unlike the buffered `exec`. With
   * `showStdout`, git's stdout goes to `stderr` too, but is not kept.
   */
  function stream(
    args: readonly string[],
    signal?: AbortSignal,
    showStdout = false,
  ): Promise<Result> {
    return new Promise((resolve, reject) => {
      const stopped = (message: string) =>
        reject(new GitError({ args, exitCode: null, stderr: message }));
      if (signal?.aborted) {
        stopped("Stopped before git started.");
        return;
      }
      let kept = "";
      const child = spawn("git", args, {
        env: gitEnv,
        windowsHide: true,
        // A TTY stdin lets git ask for a password when interactive.
        stdio: [
          interactive ? "inherit" : "ignore",
          showStdout ? "pipe" : "ignore",
          "pipe",
        ],
      });
      const abort = () => child.kill();
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => stderr(chunk));
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr(chunk);
        kept = (kept + chunk).slice(-KEPT_STDERR);
      });
      child.on("error", (error) => {
        signal?.removeEventListener("abort", abort);
        stopped(
          (error as { code?: unknown }).code === "ENOENT"
            ? "git was not found on PATH. Install git 2.27 or newer."
            : error.message,
        );
      });
      child.on("close", (code) => {
        signal?.removeEventListener("abort", abort);
        if (code === null || signal?.aborted) {
          stopped(kept || "Stopped by a signal.");
          return;
        }
        resolve({ exitCode: code, stdout: "", stderr: kept });
      });
    });
  }

  let checked: Promise<string> | undefined;
  // Shared by every call, so it never takes one caller's signal.
  function checkVersion(): Promise<string> {
    checked ??= exec(["version"]).then(({ exitCode, stdout, stderr }) => {
      if (exitCode !== 0)
        throw new GitError({ args: ["version"], exitCode, stderr });
      return parseVersion(stdout);
    });
    return checked;
  }

  /** Runs git after the version check. Exit 1 or empty output gives `undefined`. */
  async function read(
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    await checkVersion();
    const { exitCode, stdout, stderr } = await exec(args, signal);
    if (exitCode === 0) return stdout.replace(/\r?\n$/, "") || undefined;
    if (exitCode === 1) return undefined;
    throw new GitError({ args, exitCode, stderr });
  }

  /** Runs git after the version check and gives stdout; any exit but 0 is a `GitError`. */
  async function output(
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<string> {
    await checkVersion();
    const { exitCode, stdout, stderr } = await exec(args, signal);
    if (exitCode !== 0) throw new GitError({ args, exitCode, stderr });
    return stdout;
  }

  return {
    version: checkVersion,
    async originUrl(dir, options) {
      // Exit 1: the key is not set.
      return read(
        ["-C", dir, "config", "--get", "remote.origin.url"],
        options?.signal,
      );
    },
    async originHead(dir, options) {
      // Exit 1 with --quiet: the ref is missing or not symbolic.
      const head = await read(
        [
          "-C",
          dir,
          "symbolic-ref",
          "--quiet",
          "--short",
          "refs/remotes/origin/HEAD",
        ],
        options?.signal,
      );
      return head?.replace(/^(remotes\/)?origin\//, "");
    },
    async clone(url, dest, options) {
      await checkVersion();
      const args = [
        "clone",
        ...(progress ? ["--progress"] : []),
        "--",
        url,
        dest,
      ];
      const { exitCode, stderr: text } = await stream(args, options?.signal);
      if (exitCode !== 0) {
        throw new GitError({
          args,
          exitCode,
          stderr: withoutProgress(text, /^Cloning into/),
        });
      }
    },
    async pull(dir, options) {
      await checkVersion();
      const args = [
        "-C",
        dir,
        "pull",
        "--ff-only",
        "--no-rebase",
        ...(progress ? ["--progress"] : []),
      ];
      // The merge summary, such as `Already up to date.`, is on git's stdout.
      const { exitCode, stderr: text } = await stream(
        args,
        options?.signal,
        true,
      );
      if (exitCode !== 0) {
        throw new GitError({
          args,
          exitCode,
          stderr: withoutProgress(text, FETCH_REPORT),
        });
      }
    },
    async lossCheck(dir, options) {
      const signal = options?.signal;
      const args = (rest: string[]) => [
        // `--no-optional-locks`: status must not refresh and rewrite the index.
        "--no-optional-locks",
        "-C",
        dir,
        ...rest,
      ];
      const git = (...rest: string[]) => output(args(rest), signal);
      const count = async (...rest: string[]) =>
        Number((await git("rev-list", "--count", ...rest, "--")).trim());
      // The flags win over repo config that hides untracked files or submodule changes.
      const status = await git(
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=none",
      );
      const unpushed: Loss["unpushed"] = [];
      const refs = await git(
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads",
      );
      for (const ref of lines(refs)) {
        const n = await count(ref, "--not", "--remotes");
        if (n > 0) {
          unpushed.push({ branch: ref.slice("refs/heads/".length), count: n });
        }
      }
      const head = args(["rev-parse", "--verify", "--quiet", "HEAD"]);
      const { exitCode, stderr } = await exec(head, signal);
      if (exitCode !== 0 && exitCode !== 1) {
        throw new GitError({ args: head, exitCode, stderr });
      }
      // Exit 1: an unborn HEAD, with no commits to lose.
      if (exitCode === 0) {
        const n = await count("HEAD", "--not", "--branches", "--remotes");
        if (n > 0) unpushed.push({ branch: "HEAD", count: n });
      }
      const stashes = lines(await git("stash", "list")).length;
      return { uncommitted: statusPaths(status), unpushed, stashes };
    },
    async fetch(dir, options) {
      await checkVersion();
      const args = [
        "-C",
        dir,
        "fetch",
        ...(progress ? ["--progress"] : []),
        "origin",
      ];
      const { exitCode, stderr: text } = await stream(args, options?.signal);
      if (exitCode !== 0) {
        throw new GitError({
          args,
          exitCode,
          stderr: withoutProgress(text, FETCH_REPORT),
        });
      }
    },
    async worktreeList(dir, options) {
      const text = await output(
        ["-C", dir, "worktree", "list", "--porcelain"],
        options?.signal,
      );
      return parseWorktrees(text);
    },
    async localBranchExists(dir, branch, options) {
      return refExists(dir, `refs/heads/${branch}`, options);
    },
    async remoteBranchExists(dir, branch, options) {
      return refExists(dir, `refs/remotes/origin/${branch}`, options);
    },
    async worktreeAdd(dir, path, { branch, source, startPoint }, options) {
      const args = ["-C", dir, "worktree", "add"];
      if (source === "local") {
        args.push(path, branch);
      } else {
        if (startPoint === undefined) {
          throw new Error(`worktreeAdd ${source} needs a start point.`);
        }
        const track = source === "tracking" ? "--track" : "--no-track";
        args.push(track, "-b", branch, path, startPoint);
      }
      await output(args, options?.signal);
    },
    async worktreeRemove(dir, path, options) {
      await output(
        ["-C", dir, "worktree", "remove", "--force", path],
        options?.signal,
      );
    },
    async worktreePrune(dir, options) {
      await output(["-C", dir, "worktree", "prune"], options?.signal);
    },
    async branchDelete(dir, branch, { force, signal }) {
      await output(
        ["-C", dir, "branch", force ? "-D" : "-d", "--", branch],
        signal,
      );
    },
  };

  async function refExists(
    dir: string,
    ref: string,
    options?: GitCallOptions,
  ): Promise<boolean> {
    // Exit 1 with --quiet: the ref is missing.
    const hash = await read(
      ["-C", dir, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      options?.signal,
    );
    return hash !== undefined;
  }
}

/** The worktrees of `git worktree list --porcelain`: one record per worktree, split by an empty line. */
function parseWorktrees(text: string): Worktree[] {
  const worktrees: Worktree[] = [];
  for (const record of text.split(/\r?\n\r?\n/)) {
    let path: string | undefined;
    let branch: string | undefined;
    for (const line of record.split(/\r?\n/)) {
      // `resolve` gives the native form: git writes `C:/x` on Windows.
      if (line.startsWith("worktree "))
        path = resolve(line.slice("worktree ".length));
      if (line.startsWith("branch refs/heads/")) {
        branch = line.slice("branch refs/heads/".length);
      }
    }
    if (path !== undefined) {
      worktrees.push(branch === undefined ? { path } : { path, branch });
    }
  }
  return worktrees;
}

function lines(text: string): string[] {
  return text.split(/\r?\n/).filter(Boolean);
}

/** The paths of `git status --porcelain=v1 -z`. A rename or copy (`R` or `C` in X or Y) has its old path next; it is skipped. */
function statusPaths(output: string): string[] {
  const entries = output.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] as string;
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2))) index += 1;
  }
  return paths;
}

/** A progress update, such as `Receiving objects:  45% (9/20)`, maybe after `remote: `. */
const PROGRESS = /^(remote: )?[A-Za-z ]+:\s+\d+% \(/;

/**
 * A line of the fetch report: `From <url>`, or one ref update such as
 * `   a1..b2  main -> origin/main`. A rejected ref (flag `!`) is an error, so it is kept.
 */
const FETCH_REPORT = /^(From | [^!] .* -> )/;

/** The stderr lines that are not empty, not progress updates and not matched by `drop`. */
function withoutProgress(stderr: string, drop: RegExp): string {
  return stderr
    .split(/\r?\n|\r/)
    .filter((line) => line.trim() && !PROGRESS.test(line) && !drop.test(line))
    .join("\n");
}

function buildEnv(
  env: CreateGitOptions["env"],
  interactive: boolean,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !REPO_ENV.includes(name)) result[name] = value;
  }
  result.LC_ALL = "C";
  if (!interactive) {
    result.GIT_TERMINAL_PROMPT = "0";
    result.GCM_INTERACTIVE = "never";
    result.GIT_SSH_COMMAND = env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes";
  }
  return result;
}

/** The version from `git version` output; throws `git-too-old` below 2.27. */
export function parseVersion(stdout: string): string {
  const match = /^git version ((\d+)\.(\d+)\S*)/.exec(stdout.trim());
  if (!match) {
    throw new GitError({
      args: ["version"],
      exitCode: 0,
      stderr: `Could not read the git version from "${stdout.trim()}".`,
    });
  }
  const [, version = "", major = "0", minor = "0"] = match;
  const [minMajor, minMinor] = MIN_VERSION;
  if (
    Number(major) < minMajor ||
    (Number(major) === minMajor && Number(minor) < minMinor)
  ) {
    throw new XrError({
      code: "git-too-old",
      message: `git ${version} is too old. xr needs git ${minMajor}.${minMinor} or newer.`,
      hint: `Upgrade git to ${minMajor}.${minMinor} or newer, then run the command again.`,
    });
  }
  return version;
}
