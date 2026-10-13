import type { XrError } from "../errors/index.ts";
import type { LiveEvent, Report } from "./report.ts";

export type DiscoveryKind = "none" | "codebase" | "project";

/** What the folder from `--codebase-path` or the current folder is (AD-9). */
export type Discovery =
  | { kind: "none"; dir: string }
  | { kind: "codebase"; dir: string; codebase: string }
  | { kind: "project"; dir: string; codebase: string };

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
}

/** File and folder I/O. Every write goes through `writeFileAtomic`. */
export interface CtxFs {
  /** The file text, or `undefined` when the file does not exist. */
  readText(path: string): string | undefined;
  writeText(path: string, text: string): void;
  /** Makes one folder. Fails when it exists or its parent is missing. */
  mkdir(path: string): void;
  /** Deletes a file or a whole folder. A missing path is not an error. */
  remove(path: string): void;
  /** The names of the folders directly in `path`, sorted. Symlinks are left out. */
  listDirs(path: string): string[];
  exists(path: string): boolean;
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

/** A plain copy of the `transaction` runner's `tx`, which services may not import. */
export interface Tx {
  step<T>(
    label: string,
    run: (signal: AbortSignal) => T | Promise<T>,
    undo: (result: T) => void | Promise<void>,
    manualCleanup: Leftover,
  ): Promise<T>;
  final<T>(
    label: string,
    run: () => T | Promise<T>,
    manualCleanup: Leftover,
  ): Promise<T>;
}

/** One `xr` command. `cli` checks the folder kind before `run`. */
export interface CommandUnit {
  accepts: readonly DiscoveryKind[];
  /** The error for a folder kind not in `accepts`. Without it, `cli` gives `not-a-codebase`. */
  refuse?(discovery: Discovery, fs: CtxFs): XrError;
  run(ctx: Ctx): Promise<Report>;
}
