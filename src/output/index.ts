import { styleText } from "node:util";

/** `rich` has colors, `plain` has no escape codes, `json` is one JSON object. */
export type Mode = "rich" | "plain" | "json";
export type TextMode = Exclude<Mode, "json">;

export type Tone = "ok" | "warn" | "error" | "muted";

export interface StreamModes {
  stdout: Mode;
  stderr: TextMode;
}

export interface PickModesInput {
  json: boolean;
  env: Readonly<Record<string, string | undefined>>;
  isTTY: { stdout: boolean; stderr: boolean };
}

/**
 * Picks the mode of each stream. Only stdout can be `json`. `FORCE_COLOR` wins
 * over `NO_COLOR`, the same as Node.
 */
export function pickModes({ json, env, isTTY }: PickModesInput): StreamModes {
  return {
    stdout: json ? "json" : textMode(env, isTTY.stdout),
    stderr: textMode(env, isTTY.stderr),
  };
}

function textMode(env: PickModesInput["env"], isTTY: boolean): TextMode {
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") return "rich";
  if (env.NO_COLOR) return "plain";
  if (env.TERM === "dumb") return "plain";
  return isTTY ? "rich" : "plain";
}

export interface Warning {
  code: string;
  message: string;
  hint?: string;
}

/** The error of a failed command. Same fields as `XrError`, which `output` may not import. */
export interface ReportError {
  code: string;
  message: string;
  hint?: string;
  details?: Record<string, unknown>;
}

export type RepoStatus = "ok" | "skipped" | "failed" | "conflict";

/** Live progress. Every event goes to stderr, in every mode. */
export type LiveEvent =
  | { type: "step-start"; text: string }
  | { type: "step-end"; text: string; ok: boolean }
  | { type: "repo"; repo: string; status: RepoStatus; message?: string }
  | { type: "warning"; warning: Warning };

/** The final result of a command. `ok` is true when `error` is absent. */
export interface Report {
  /** The command's own fields of the JSON object, next to `ok`, `warnings` and `error`. */
  data?: Record<string, unknown> & {
    ok?: never;
    warnings?: never;
    error?: never;
  };
  /** What `rich` and `plain` mode print on stdout. */
  text?: string;
  error?: ReportError;
}

export interface Output {
  emit(event: LiveEvent): void;
  /** Writes a stack trace to stderr. */
  trace(text: string): void;
  /** Writes the final Report: to stdout, and the error to stderr in text mode. */
  report(report: Report): void;
}

export interface CreateOutputOptions {
  modes: StreamModes;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const SYMBOL = { ok: "✓", failed: "✗", warning: "!", skipped: "–" } as const;

const REPO_LOOK: Record<RepoStatus, { symbol: string; tone: Tone }> = {
  ok: { symbol: SYMBOL.ok, tone: "ok" },
  skipped: { symbol: SYMBOL.skipped, tone: "muted" },
  failed: { symbol: SYMBOL.failed, tone: "error" },
  conflict: { symbol: SYMBOL.warning, tone: "warn" },
};

const TONE_FORMAT = {
  ok: "green",
  warn: "yellow",
  error: "red",
  muted: "dim",
} as const;

/** Creates the one writer of `xr` output. Warnings are kept for the JSON Report. */
export function createOutput({
  modes,
  stdout,
  stderr,
}: CreateOutputOptions): Output {
  const warnings: Warning[] = [];
  const paint = (tone: Tone, text: string): string =>
    modes.stderr === "rich"
      ? styleText(TONE_FORMAT[tone], text, { validateStream: false })
      : text;
  const line = (text: string) => stderr(`${text}\n`);

  return {
    emit(event) {
      switch (event.type) {
        case "step-start":
          line(paint("muted", `${event.text}…`));
          break;
        case "step-end":
          line(
            event.ok
              ? `${paint("ok", SYMBOL.ok)} ${event.text}`
              : `${paint("error", SYMBOL.failed)} ${event.text}`,
          );
          break;
        case "repo": {
          const { symbol, tone } = REPO_LOOK[event.status];
          const message = event.message ? `: ${event.message}` : "";
          line(`${paint(tone, symbol)} ${event.repo}${message}`);
          break;
        }
        case "warning":
          warnings.push(event.warning);
          line(`${paint("warn", SYMBOL.warning)} ${event.warning.message}`);
          if (event.warning.hint)
            line(paint("muted", `  ${event.warning.hint}`));
          break;
      }
    },
    trace(text) {
      line(paint("muted", text));
    },
    report({ data, text, error }) {
      if (modes.stdout === "json") {
        stdout(`${JSON.stringify(envelope(warnings, data, error))}\n`);
        return;
      }
      if (text) stdout(text);
      if (error) {
        line(`${paint("error", "error:")} ${error.message}`);
        if (error.hint) line(paint("muted", error.hint));
      }
    },
  };
}

function envelope(
  warnings: Warning[],
  data: Report["data"],
  error: ReportError | undefined,
): Record<string, unknown> {
  if (!error) return { ok: true, warnings, ...data };
  const { code, message, hint, details } = error;
  return {
    ok: false,
    warnings,
    ...data,
    error: {
      code,
      message,
      ...(hint === undefined ? {} : { hint }),
      ...(details === undefined ? {} : { details }),
    },
  };
}
