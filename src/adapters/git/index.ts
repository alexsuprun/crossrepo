import { execFile } from "node:child_process";
import { GitError, XrError } from "../../errors/index.ts";

/** Named git calls, as `ctx.git`. There is no generic `run`, `commit` or `add`. */
export interface Git {
  /** The version from `git version`, such as `2.45.1` or `2.45.1.windows.1`. */
  version(): Promise<string>;
  /** The raw `remote.origin.url` of the repo at `dir` (no `insteadOf`), or `undefined`. */
  originUrl(dir: string): Promise<string | undefined>;
  /** The branch `origin/HEAD` points to, without `origin/`, or `undefined` when it is not set. */
  originHead(dir: string): Promise<string | undefined>;
}

export interface CreateGitOptions {
  /** When false, git may never wait for a password or a prompt. */
  interactive: boolean;
  env: Readonly<Record<string, string | undefined>>;
}

const MIN_VERSION = [2, 27] as const;

/** Environment variables that would point git at another repo than `-C`. */
const REPO_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"];

interface Result {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Builds `ctx.git`. The first call of any method checks that git is 2.27 or newer. */
export function createGit({ interactive, env }: CreateGitOptions): Git {
  const gitEnv = buildEnv(env, interactive);

  async function exec(args: readonly string[]): Promise<Result> {
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        args,
        { env: gitEnv, encoding: "utf8", windowsHide: true },
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

  let checked: Promise<string> | undefined;
  function checkVersion(): Promise<string> {
    checked ??= exec(["version"]).then(({ exitCode, stdout, stderr }) => {
      if (exitCode !== 0)
        throw new GitError({ args: ["version"], exitCode, stderr });
      return parseVersion(stdout);
    });
    return checked;
  }

  /** Runs git after the version check. Exit 1 or empty output gives `undefined`. */
  async function read(args: readonly string[]): Promise<string | undefined> {
    await checkVersion();
    const { exitCode, stdout, stderr } = await exec(args);
    if (exitCode === 0) return stdout.replace(/\r?\n$/, "") || undefined;
    if (exitCode === 1) return undefined;
    throw new GitError({ args, exitCode, stderr });
  }

  return {
    version: checkVersion,
    async originUrl(dir) {
      // Exit 1: the key is not set.
      return read(["-C", dir, "config", "--get", "remote.origin.url"]);
    },
    async originHead(dir) {
      // Exit 1 with --quiet: the ref is missing or not symbolic.
      const head = await read([
        "-C",
        dir,
        "symbolic-ref",
        "--quiet",
        "--short",
        "refs/remotes/origin/HEAD",
      ]);
      return head?.replace(/^(remotes\/)?origin\//, "");
    },
  };
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
function parseVersion(stdout: string): string {
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
