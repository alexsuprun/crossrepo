import type { XrError } from "../errors/index.ts";
import type { LiveEvent, Report } from "./report.ts";

export type DiscoveryKind = "none" | "codebase" | "project" | "broken-project";

/**
 * What the folder from `--codebase-path` or the current folder is (AD-9).
 * `broken-project`: a project record that gives no codebase; `error` is the
 * discovery error other commands fail with.
 */
export type Discovery =
  | { kind: "none"; dir: string }
  | { kind: "codebase"; dir: string; codebase: string }
  | { kind: "project"; dir: string; codebase: string }
  | { kind: "broken-project"; dir: string; error: Error };

/** The codebase folder: the codebase of a project, else the folder itself. Not for `broken-project`. */
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
  /** The merged `name`, when set. */
  name?: string;
  /** The merged `project.pre-create` lines, in order. */
  preCreate: string[];
  /** The merged `project.post-create` lines, in order. */
  postCreate: string[];
  /** The merged `project.pre-remove` lines, in order. */
  preRemove: string[];
  /** The merged `project.post-remove` lines, in order. */
  postRemove: string[];
  /** The merged `project.vars`; numbers and booleans are text already. */
  vars: Record<string, string>;
  /** The keys of any level that the schema does not know, with the files that set them. */
  unknownKeys: UnknownConfigKey[];
}

/** A config key the schema does not know (D56). */
export interface UnknownConfigKey {
  /** Dotted, e.g. `repos.web.remot`. */
  key: string;
  files: string[];
  /** The closest known key, dotted; may be empty. */
  suggestion: string;
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
  /** Changed, staged and untracked files that are not ignored, in the one worktree at `dir` (D36). Reads only. */
  uncommittedFiles(dir: string, options?: GitCallOptions): Promise<string[]>;
  /** `git -C <dir> fetch origin`. git's output goes to stderr. */
  fetch(dir: string, options?: GitCallOptions): Promise<void>;
  /** Each worktree of the repo, the main one first, with its branch when one is checked out. */
  worktreeList(
    dir: string,
    options?: GitCallOptions,
  ): Promise<{ path: string; branch?: string }[]>;
  localBranchExists(
    dir: string,
    branch: string,
    options?: GitCallOptions,
  ): Promise<boolean>;
  /** `origin/<branch>` exists. */
  remoteBranchExists(
    dir: string,
    branch: string,
    options?: GitCallOptions,
  ): Promise<boolean>;
  /** `git worktree add`, never with `--force`; `tracking` uses `--track`, `new` uses `--no-track`. */
  worktreeAdd(
    dir: string,
    path: string,
    add: {
      branch: string;
      source: BranchSource;
      startPoint?: string;
    },
    options?: GitCallOptions,
  ): Promise<void>;
  /** `git worktree remove --force <path>`. */
  worktreeRemove(
    dir: string,
    path: string,
    options?: GitCallOptions,
  ): Promise<void>;
  worktreePrune(dir: string, options?: GitCallOptions): Promise<void>;
  /** `git branch -d`, or `-D` with `force`. */
  branchDelete(
    dir: string,
    branch: string,
    options: GitCallOptions & { force: boolean },
  ): Promise<void>;
  /** The checked-out branch, or `undefined` for a detached HEAD. */
  currentBranch(
    dir: string,
    options?: GitCallOptions,
  ): Promise<string | undefined>;
  /** The worktree has a `MERGE_HEAD`. */
  mergeInProgress(dir: string, options?: GitCallOptions): Promise<boolean>;
  /** The unmerged files of the worktree. Reads only. */
  unmergedFiles(dir: string, options?: GitCallOptions): Promise<string[]>;
  /**
   * `git merge --autostash --no-edit <ref>`, the only call that can commit. A
   * conflict stays in git's conflict state; any other failure is a `GitError`.
   */
  mergeAutostash(dir: string, ref: string): Promise<MergeResult>;
}

/** What `mergeAutostash` did; `stashKept`: the uncommitted changes stay in `git stash list`. */
export type MergeResult =
  | { result: "up-to-date"; stashKept: boolean }
  | { result: "merged"; fastForward: boolean; stashKept: boolean }
  | { result: "conflict"; files: string[]; stashKept: boolean };

/** Where the branch of a new worktree comes from (D37). */
export type BranchSource = "local" | "tracking" | "new";

/** The PID lock adapter. Only the runners take it. */
export interface CtxLock {
  /** Throws `lock-held` when another running process holds it. */
  acquire(path: string): { release(): void; stalePid?: number };
}

/** What a command asks for when an argument is missing. The adapter builds the `missing-argument` error from it. */
export interface PickRequest {
  /** The argument name, for `error.details.argument`. */
  argument: string;
  /** The picker title. */
  message: string;
  /** The values to pick from, in the order shown. */
  choices: readonly string[];
  /** A muted text shown next to a choice, by choice value. */
  hints?: Readonly<Record<string, string>>;
  /** The start of the error message when there is no picker. */
  missing: string;
  /** The word before the list of choices in that message, e.g. `Choices`. */
  listLabel: string;
  hint: string;
  /** The error message and hint when there are no choices. */
  empty: { message: string; hint: string };
}

/**
 * Asks for a missing argument. Opens a picker only when `interactive`; else, or
 * with no choices, throws `missing-argument`. A cancelled picker throws `interrupted`.
 */
export interface CtxPrompt {
  pick(request: PickRequest): Promise<string>;
  /** The marked choices, at least one, in list order. */
  pickMany(request: PickRequest): Promise<string[]>;
}

/** What one hook line gave. `output` is the end of its stdout and stderr together. */
export type HookResult =
  | { ok: true }
  | {
      ok: false;
      exitCode: number | null;
      timedOut: boolean;
      output: string;
    };

/** The hooks adapter: the only code that starts `sh` (AD-11). */
export interface CtxHooks {
  /** The `sh` to use, found once per run. Throws `sh-not-found`. */
  findSh(): string;
  /** One `sh -c` line, stdin closed, live output to stderr. An aborted `signal` kills its process tree. */
  run(line: {
    command: string;
    cwd: string;
    env: Readonly<Record<string, string>>;
    signal?: AbortSignal;
  }): Promise<HookResult>;
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
  prompt: CtxPrompt;
  /** `path` is `<codebase>/.crossrepo/xr.lock`, resolved by `cli` (AD-7). */
  lock: { path: string; adapter: CtxLock };
  /** Ctrl-C. Only the runners listen; `on` gives the function that stops listening. */
  interrupts: { on(handler: () => void): () => void };
  /** Test only (`XR_TEST_STEP_DELAY_MS`): the runner waits this long after each step. */
  stepDelayMs?: number;
  hooks: CtxHooks;
  /** The env `xr` got; hooks inherit it. */
  env: Readonly<Record<string, string | undefined>>;
  /** `process.platform`, or a fixed one in tests. */
  platform: string;
  /** The clock, fixed in tests. */
  now(): Date;
  /** Changes the current folder of the `xr` process; a recording fake in tests. */
  chdir(dir: string): void;
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
  /** The files with a merge conflict, for a `conflict`. */
  files?: string[];
  /** For a `conflict`: the uncommitted changes stay in `git stash list`. */
  stashKept?: boolean;
  /** What a stopped repo left on disk; the runner lists it as a leftover. */
  leftover?: Leftover;
}

/** One `xr` command. `cli` checks the folder kind before `run`. */
export interface CommandUnit {
  accepts: readonly DiscoveryKind[];
  /** The command reports unknown config keys itself, so `cli` does not emit them as live warnings. */
  reportsUnknownKeys?: boolean;
  /** The error for a folder kind not in `accepts`. Without it, `cli` gives `not-a-codebase`. */
  refuse?(discovery: Discovery, fs: CtxFs): XrError;
  /** `args` are the positional arguments of the command, as given; `options` its own flags, camelCase. */
  run(
    ctx: Ctx,
    args: readonly string[],
    options?: Readonly<Record<string, unknown>>,
  ): Promise<Report>;
}
