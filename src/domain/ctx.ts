import type { XrError } from "../errors/index.ts";
import type { LiveEvent, Report } from "./report.ts";

export type DiscoveryKind = "none" | "codebase" | "project";

/** What the folder from `--codebase-path` or the current folder is (AD-9). */
export type Discovery =
  | { kind: "none"; dir: string }
  | { kind: "codebase"; dir: string; codebase: string }
  | { kind: "project"; dir: string; codebase: string };

/** The codebase folder: the codebase of a project, else the folder itself. */
export function codebaseDir(discovery: Discovery): string {
  return "codebase" in discovery ? discovery.codebase : discovery.dir;
}

export type ConfigSource = { kind: "file"; path: string } | { kind: "default" };

/** One merged leaf key in dotted form. A hook list is one entry. */
export interface ConfigEntry {
  key: string;
  value: string | string[];
  source: ConfigSource;
  /** Only on `projects-dir`: the absolute path. */
  resolved?: string;
}

/** The merged config as commands see it. */
export interface ConfigView {
  /** Absent when the folder is not a codebase yet. */
  codebase?: string;
  entries: ConfigEntry[];
  projectsDir: { value: string; source: ConfigSource; resolved: string };
  /** The merged `repos`, in config order. A key that is not set is `undefined`. */
  repos: ConfigRepoView[];
}

/** One merged entry of `repos`. */
export interface ConfigRepoView {
  name: string;
  remote?: string;
  defaultBranch?: string;
  description?: string;
}

/** File and folder I/O. Every write goes through `writeFileAtomic`. */
export interface CtxFs {
  /** The file text, or `undefined` when the file does not exist. */
  readText(path: string): string | undefined;
  writeText(path: string, text: string): void;
  /** Makes one folder. Fails when it exists or its parent is missing. */
  mkdir(path: string): void;
  /** Deletes a file or a whole folder, also read-only files. A missing path is not an error. */
  remove(path: string): void;
  /** The names of the folders directly in `path`, sorted. Symlinks are left out. */
  listDirs(path: string): string[];
  exists(path: string): boolean;
  /** The absolute path with every symlink resolved. Throws when the path is missing. */
  realpath(path: string): string;
  /** The device and inode of the path, symlinks followed, or `undefined` when it is missing. */
  stat(path: string): { dev: bigint; ino: bigint } | undefined;
}

/** Options of every git call. An aborted `signal` stops git. */
export interface GitCallOptions {
  signal?: AbortSignal;
}

/** Named git calls. The first call checks that git is 2.27 or newer (`git-too-old`). */
export interface CtxGit {
  version(): Promise<string>;
  /** The raw `origin` URL, or `undefined` when the repo has no `origin`. */
  originUrl(dir: string, options?: GitCallOptions): Promise<string | undefined>;
  /** The branch `origin/HEAD` points to, without `origin/`, or `undefined`. */
  originHead(
    dir: string,
    options?: GitCallOptions,
  ): Promise<string | undefined>;
  /** `git clone -- <url> <dest>`, with the URL as given. git's output goes to stderr. */
  clone(url: string, dest: string, options?: GitCallOptions): Promise<void>;
  /** `git -C <dir> pull --ff-only --no-rebase` on the checked-out branch. git's output goes to stderr. */
  pull(dir: string, options?: GitCallOptions): Promise<void>;
  /** Uncommitted and untracked files, unpushed commits per local branch, and stashes. Reads only. */
  lossCheck(
    dir: string,
    options?: GitCallOptions,
  ): Promise<{
    uncommitted: string[];
    unpushed: { branch: string; count: number }[];
    stashes: number;
  }>;
}

/** The PID lock adapter. Only the runners take it. */
export interface CtxLock {
  /** Throws `lock-held` when another running process holds it. */
  acquire(path: string): { release(): void; stalePid?: number };
}

/** The one plain object `cli` builds for each run (AD-1). Commands do all I/O through it. */
export interface Ctx {
  out: { emit(event: LiveEvent): void };
  fs: CtxFs;
  git: CtxGit;
  config: ConfigView;
  discovery: Discovery;
  /** The folder where `xr` runs. Only for resolving path arguments; discovery uses `discovery`. */
  cwd: string;
  /** stdin and stdout are a TTY, and neither `--json` nor `--no-interactive` is given. */
  interactive: boolean;
  /** `path` is `<codebase>/.crossrepo/xr.lock`, resolved by `cli` (AD-7). */
  lock: { path: string; adapter: CtxLock };
  /** Ctrl-C. Only the runners listen; `on` gives the function that stops listening. */
  interrupts: { on(handler: () => void): () => void };
  /** Test only (`XR_TEST_STEP_DELAY_MS`): the runner waits this long after each step. */
  stepDelayMs?: number;
}

/** What a failed undo leaves behind, and the command that removes it by hand. */
export interface Leftover {
  what: string;
  path: string;
  command: string;
}

/** One step of a delete phase: no undo, never aborted. */
export interface FinalStep {
  label: string;
  run: () => unknown;
  manualCleanup: Leftover;
}

/** A plain copy of the `transaction` runner's `tx`, which services may not import. */
export interface Tx {
  /** Aborts on the first Ctrl-C. */
  readonly signal: AbortSignal;
  step<T>(
    label: string,
    run: (signal: AbortSignal) => T | Promise<T>,
    undo: (result: T) => void | Promise<void>,
    manualCleanup: Leftover,
  ): Promise<T>;
  /** Runs the steps in order; a failed or stopped phase lists the failed step and every step not run. */
  finals(steps: readonly FinalStep[]): Promise<void>;
}

/** A plain copy of the `perRepo` runner's result of one repo, which services may not import. */
export interface RepoResult {
  repo: string;
  status: "ok" | "skipped" | "failed" | "conflict";
  message?: string;
  hint?: string;
  /** What a stopped repo left on disk; the runner lists it as a leftover. */
  leftover?: Leftover;
}

/** One `xr` command. `cli` checks the folder kind before `run`. */
export interface CommandUnit {
  accepts: readonly DiscoveryKind[];
  /** The error for a folder kind not in `accepts`. Without it, `cli` gives `not-a-codebase`. */
  refuse?(discovery: Discovery, fs: CtxFs): XrError;
  /** `args` are the positional arguments of the command, as given; `options` its own flags, camelCase. */
  run(
    ctx: Ctx,
    args: readonly string[],
    options?: Readonly<Record<string, unknown>>,
  ): Promise<Report>;
}
