import type { Readable, Writable } from "node:stream";
import { isCancel, multiselect, select } from "@clack/prompts";
import { interrupted, XrError } from "../../errors/index.ts";

/** What a command asks for when an argument is missing. */
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

/** The one-choice picker; `cli` merges it with `MultiPrompt` into `ctx.prompt`. */
export interface Prompt {
  /**
   * Gives the picked choice. With no choices, or when not interactive, throws
   * `missing-argument` and never reads the input. A cancel (Ctrl-C or Escape) throws `interrupted`.
   */
  pick(request: PickRequest): Promise<string>;
}

/** The multi-select picker. */
export interface MultiPrompt {
  /**
   * Gives the marked choices, at least one, in list order. The same no-choices,
   * not-interactive and cancel rules as `pick`.
   */
  pickMany(request: PickRequest): Promise<string[]>;
}

export interface CreatePromptOptions {
  /** stdin and stdout are a TTY, and neither `--json` nor `--no-interactive` is given. */
  interactive: boolean;
  /** Default `process.stdin`. */
  input?: Readable;
  /** Default `process.stderr`, so stdout keeps only the Report (AD-4). */
  output?: Writable;
}

/** The only user of `@clack/prompts` (AD-5). It never uses `spinner`, `tasks` or `block`. */
export function createPrompt({
  interactive,
  input,
  output,
}: CreatePromptOptions): Prompt {
  return {
    async pick(request) {
      checkCanPick(request, interactive);
      // clack reads Ctrl-C as a key in raw mode, so no SIGINT handler is needed here.
      const picked = await select({
        message: request.message,
        options: request.choices.map((value) => ({
          value,
          hint: request.hints?.[value],
        })),
        input: input ?? process.stdin,
        output: output ?? process.stderr,
      });
      if (isCancel(picked)) throw interrupted();
      return picked;
    },
  };
}

/** The multi-select picker, with clack `multiselect`. */
export function createMultiPrompt({
  interactive,
  input,
  output,
}: CreatePromptOptions): MultiPrompt {
  return {
    async pickMany(request) {
      checkCanPick(request, interactive);
      const picked = await multiselect({
        message: request.message,
        options: request.choices.map((value) => ({ value })),
        required: true,
        input: input ?? process.stdin,
        output: output ?? process.stderr,
      });
      if (isCancel(picked)) throw interrupted();
      const marked = new Set(picked);
      return request.choices.filter((choice) => marked.has(choice));
    },
  };
}

/** Throws `missing-argument` when there is no picker to open. */
function checkCanPick(
  { argument, choices, missing, listLabel, hint, empty }: PickRequest,
  interactive: boolean,
): void {
  if (choices.length === 0) {
    throw missingArgument(empty.message, empty.hint, argument, []);
  }
  if (!interactive) {
    throw missingArgument(
      `${missing} ${listLabel}: ${choices.join(", ")}.`,
      hint,
      argument,
      [...choices],
    );
  }
}

function missingArgument(
  message: string,
  hint: string,
  argument: string,
  choices: string[],
): XrError {
  return new XrError({
    code: "missing-argument",
    message,
    hint,
    details: { argument, choices },
  });
}
