/** Every `XrError` code. A new failure reuses a code when the meaning is the same. */
export const ERROR_CODES = [
  "usage",
  "internal",
  "not-a-codebase",
  "unknown-config-key",
  "config-conflict",
  "invalid-config",
  "file-busy",
  "git-too-old",
  "git-failed",
  "repos-not-ready",
  "already-a-codebase",
  "inside-a-project",
  "lock-held",
  "interrupted",
  "stale-lock",
  "not-in-codebase",
  "repo-exists",
  "repo-not-found",
  "repo-in-use",
  "invalid-project-record",
  "would-lose-work",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
export const EXIT_INTERRUPTED = 130;

/**
 * A Report block, as `errors` sees it. `errors` may not import the Report types,
 * so `cli` reads these as the real blocks.
 */
export interface ErrorBlock {
  readonly type: string;
  readonly [field: string]: unknown;
}

export interface XrErrorInit {
  code: ErrorCode;
  message: string;
  hint?: string;
  details?: Record<string, unknown>;
  /** Report blocks; their data is `error.details` in JSON. */
  blocks?: readonly ErrorBlock[];
  cause?: unknown;
}

/** The one error shape of crossrepo. Agents branch on `code`, never on the message. */
export class XrError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly details?: Record<string, unknown>;
  blocks?: readonly ErrorBlock[];

  constructor({ code, message, hint, details, blocks, cause }: XrErrorInit) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "XrError";
    this.code = code;
    this.hint = hint;
    this.details = details;
    this.blocks = blocks;
  }
}

export interface GitErrorInit {
  args: readonly string[];
  /** `null` when git did not start or was stopped by a signal. */
  exitCode: number | null;
  stderr: string;
}

/** A git call that failed. The message names the git command and the first stderr line. */
export class GitError extends XrError {
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor({ args, exitCode, stderr }: GitErrorInit) {
    const command = `\`git ${args.join(" ")}\``;
    const first = stderr.trim().split(/\r?\n/)[0];
    super({
      code: "git-failed",
      message: first
        ? `${command} failed: ${first}`
        : `${command} failed with exit code ${exitCode}.`,
    });
    this.name = "GitError";
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/**
 * Adds `blocks` to a thrown error. An `XrError` keeps its class; anything else
 * becomes an `internal` `XrError` with it as `cause` and its stack.
 */
export function withBlocks(
  thrown: unknown,
  blocks: readonly ErrorBlock[],
): XrError {
  if (thrown instanceof XrError) {
    thrown.blocks = [...(thrown.blocks ?? []), ...blocks];
    return thrown;
  }
  const error = new XrError({
    code: "internal",
    message: thrown instanceof Error ? thrown.message : String(thrown),
    blocks,
    cause: thrown,
  });
  if (thrown instanceof Error && thrown.stack) error.stack = thrown.stack;
  return error;
}

/** Maps an error to the process exit code: `usage` is 2, `interrupted` is 130, every other code is 1. */
export function exitCodeFor(error: XrError): number {
  if (error.code === "usage") return EXIT_USAGE;
  if (error.code === "interrupted") return EXIT_INTERRUPTED;
  return EXIT_FAILURE;
}
