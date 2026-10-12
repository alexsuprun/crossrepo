/** Every `XrError` code. A new failure reuses a code when the meaning is the same. */
export const ERROR_CODES = [
  "usage",
  "internal",
  "not-a-codebase",
  "unknown-config-key",
  "config-conflict",
  "invalid-config",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
export const EXIT_INTERRUPTED = 130;

export interface XrErrorInit {
  code: ErrorCode;
  message: string;
  hint?: string;
  details?: Record<string, unknown>;
}

/** The one error shape of crossrepo. Agents branch on `code`, never on the message. */
export class XrError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly details?: Record<string, unknown>;

  constructor({ code, message, hint, details }: XrErrorInit) {
    super(message);
    this.name = "XrError";
    this.code = code;
    this.hint = hint;
    this.details = details;
  }
}

/** Maps an error to the process exit code: `usage` is 2, every other code is 1. */
export function exitCodeFor(error: XrError): number {
  return error.code === "usage" ? EXIT_USAGE : EXIT_FAILURE;
}
