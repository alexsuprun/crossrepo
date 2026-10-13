import { isAbsolute, join, relative, sep } from "node:path";
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
 * over `NO_COLOR`, and only the values Node reads as color give `rich`.
 */
export function pickModes({ json, env, isTTY }: PickModesInput): StreamModes {
  return {
    stdout: json ? "json" : textMode(env, isTTY.stdout),
    stderr: textMode(env, isTTY.stderr),
  };
}

const FORCE_COLOR_ON = ["", "1", "2", "3", "true"];

function textMode(env: PickModesInput["env"], isTTY: boolean): TextMode {
  if (env.FORCE_COLOR !== undefined) {
    return FORCE_COLOR_ON.includes(env.FORCE_COLOR) ? "rich" : "plain";
  }
  if (env.NO_COLOR) return "plain";
  if (env.TERM === "dumb") return "plain";
  return isTTY ? "rich" : "plain";
}

export interface Warning {
  code: string;
  message: string;
  hint?: string;
}

/**
 * A value in a block. In text modes a path shows relative to the codebase or `~`,
 * and a code shows as a command. In JSON a path is absolute and a code is a plain string.
 */
export type Text = string | { path: string } | { code: string };

export type RepoStatus = "ok" | "skipped" | "failed" | "conflict";

export interface FieldItem {
  key: string;
  /** A list prints one item per indented line in text modes, and is an array in JSON. */
  value: Text | Text[];
  source?: Text;
  extra?: Record<string, Text>;
}

/** What a part of the Report is, never how it looks. The set is closed (AD-3). */
export type Block =
  | { type: "value"; key: string; value: Text }
  | { type: "fields"; key: string; items: FieldItem[] }
  /** Rows of records. Each record has the same keys, which are the JSON field names. */
  | { type: "table"; key: string; items: Record<string, Text>[] }
  | {
      type: "repos";
      items: { repo: string; status: RepoStatus; message?: Text }[];
    }
  | { type: "checks"; items: { id: string; status: string; fix?: Text }[] }
  | {
      type: "leftovers";
      items: { what: string; path: Text; command: Text }[];
    }
  | { type: "section"; key: string; title: Text; blocks: Block[] }
  | { type: "note"; tone: Tone; text: Text };

/** The error of a failed command. Same fields as `XrError`, which `output` may not import. */
export interface ReportError {
  code: string;
  message: string;
  hint?: string;
  /** Their data is `error.details` in JSON. */
  blocks?: Block[];
}

/** Live progress. Every event goes to stderr, in every mode. */
export type LiveEvent =
  | { type: "step-start"; text: string }
  | { type: "step-end"; text: string; ok: boolean }
  | { type: "repo"; repo: string; status: RepoStatus; message?: string }
  | { type: "warning"; warning: Warning };

/** The final result of a command. `ok` is true when `error` is absent. */
export interface Report {
  blocks: Block[];
  error?: ReportError;
}

export interface Output {
  emit(event: LiveEvent): void;
  /** Writes a stack trace to stderr. */
  trace(text: string): void;
  /**
   * Writes the final Report: blocks to stdout on success, everything to stderr on
   * failure in text modes. Throws on a key clash or a block type with no renderer yet.
   */
  report(report: Report): void;
}

export interface CreateOutputOptions {
  modes: StreamModes;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** The home folder, for `~` in text-mode paths. */
  home: string;
  /** The codebase folder, when known. Text-mode paths inside it are relative to it. */
  codebase?: string;
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

const RESERVED_KEYS = new Set(["ok", "warnings", "error", "notes"]);

/** Creates the one writer of `xr` output. Warnings are kept for the JSON Report. */
export function createOutput({
  modes,
  stdout,
  stderr,
  home,
  codebase,
}: CreateOutputOptions): Output {
  const warnings: Warning[] = [];
  const painter =
    (mode: Mode) =>
    (tone: Tone, text: string): string =>
      mode === "rich"
        ? styleText(TONE_FORMAT[tone], text, { validateStream: false })
        : text;
  const paint = painter(modes.stderr);
  const line = (text: string) => stderr(`${text}\n`);
  const show = (text: Text) => showText(text, home, codebase);

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
    report({ blocks, error }) {
      const data = blocksData(blocks, true);
      const details = error?.blocks ? blocksData(error.blocks, false) : {};
      if (modes.stdout === "json") {
        stdout(`${JSON.stringify(envelope(warnings, data, error, details))}\n`);
        return;
      }
      if (!error) {
        const text = renderBlocks(blocks, painter(modes.stdout), show);
        if (text) stdout(text);
        return;
      }
      stderr(renderBlocks(blocks, paint, show) + (blocks.length ? "\n" : ""));
      line(`${paint("error", "error:")} ${error.message}`);
      if (error.hint) line(paint("muted", error.hint));
      if (error.blocks?.length) {
        stderr(`\n${renderBlocks(error.blocks, paint, show)}`);
      }
    },
  };
}

type Paint = (tone: Tone, text: string) => string;

/** The JSON data of `blocks`. Throws on a key clash, which is a bug in the command. */
function blocksData(
  blocks: readonly Block[],
  topLevel: boolean,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const notes = blocks.flatMap((block) =>
    block.type === "note" ? [jsonText(block.text)] : [],
  );
  for (const block of blocks) {
    if (block.type === "note") continue;
    const [key, value] = blockData(block);
    if (topLevel && RESERVED_KEYS.has(key)) {
      throw new Error(`The Report uses the reserved key "${key}".`);
    }
    if (Object.hasOwn(data, key)) {
      throw new Error(`The Report has the key "${key}" twice.`);
    }
    data[key] = value;
  }
  if (notes.length) {
    if (Object.hasOwn(data, "notes")) {
      throw new Error('The Report has the key "notes" twice.');
    }
    data.notes = notes;
  }
  return data;
}

function blockData(block: Block): [string, unknown] {
  switch (block.type) {
    case "value":
      return [block.key, jsonText(block.value)];
    case "fields":
      return [
        block.key,
        block.items.map(({ key, value, source, extra }) => ({
          key,
          value: Array.isArray(value) ? value.map(jsonText) : jsonText(value),
          ...(source === undefined ? {} : { source: jsonText(source) }),
          ...mapValues(extra ?? {}, jsonText),
        })),
      ];
    case "table":
      return [block.key, block.items.map((item) => mapValues(item, jsonText))];
    case "leftovers":
      return [
        "leftovers",
        block.items.map(({ what, path, command }) => ({
          what,
          path: jsonText(path),
          command: jsonText(command),
        })),
      ];
    default:
      return noRenderer(block);
  }
}

// TODO: the stories that first use these block types add their renderers (W2).
function noRenderer(block: Block): never {
  throw new Error(`The "${block.type}" block has no renderer yet.`);
}

function mapValues<T, U>(
  record: Record<string, T>,
  map: (value: T) => U,
): Record<string, U> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, map(value)]),
  );
}

function jsonText(text: Text): string {
  if (typeof text === "string") return text;
  return "path" in text ? text.path : text.code;
}

/** In text modes, a path is relative to the codebase, else to `~`, else absolute. */
function showText(text: Text, home: string, codebase?: string): string {
  if (typeof text === "string") return text;
  if ("code" in text) return text.code;
  if (codebase !== undefined) {
    const inside = insideOf(codebase, text.path);
    if (inside !== undefined) return inside || ".";
  }
  const inHome = insideOf(home, text.path);
  if (inHome === undefined) return text.path;
  return inHome ? join("~", inHome) : "~";
}

/** The path of `target` relative to `folder`, or `undefined` when it is outside. */
function insideOf(folder: string, target: string): string | undefined {
  const rel = relative(folder, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return undefined;
  }
  return rel;
}

/** One text renderer for `rich` and `plain`; `plain` only skips the colors. */
function renderBlocks(
  blocks: readonly Block[],
  paint: Paint,
  show: (text: Text) => string,
): string {
  return blocks
    .filter((block) => block.type !== "table" || block.items.length > 0)
    .map((block) => `${renderBlock(block, paint, show)}\n`)
    .join("\n");
}

function renderBlock(
  block: Block,
  paint: Paint,
  show: (text: Text) => string,
): string {
  switch (block.type) {
    case "value":
      return show(block.value).replace(/\n$/, "");
    case "fields":
      return renderFields(block.items, paint, show);
    case "table":
      return renderTable(block.items, show);
    case "note":
      return paint(block.tone, show(block.text));
    case "leftovers":
      return block.items
        .map(
          ({ what, path, command }) =>
            `${what}: ${show(path)}\n${paint("muted", `  ${show(command)}`)}`,
        )
        .join("\n");
    default:
      return noRenderer(block);
  }
}

function renderFields(
  items: readonly FieldItem[],
  paint: Paint,
  show: (text: Text) => string,
): string {
  const keyWidth = Math.max(...items.map((item) => item.key.length));
  const valueWidth = Math.max(
    0,
    ...items.map((item) =>
      Array.isArray(item.value) ? 0 : show(item.value).length,
    ),
  );
  return items
    .map(({ key, value, source, extra }) => {
      const tail = [
        ...Object.entries(extra ?? {}).map(
          ([name, text]) => `${name} ${show(text)}`,
        ),
        ...(source === undefined ? [] : [show(source)]),
      ].join("  ");
      const shown = Array.isArray(value) ? "" : show(value);
      const head = `${key.padEnd(keyWidth)} =`;
      const first = tail
        ? `${head} ${shown.padEnd(valueWidth)}  ${paint("muted", tail)}`
        : shown
          ? `${head} ${shown}`
          : head;
      if (!Array.isArray(value)) return first;
      return [first, ...value.map((item) => `  ${show(item)}`)].join("\n");
    })
    .join("\n");
}

/** One row per record, columns padded to the widest cell; the last column is not padded. */
function renderTable(
  items: readonly Record<string, Text>[],
  show: (text: Text) => string,
): string {
  const rows = items.map((item) => Object.values(item).map(show));
  const widths = rows.reduce<number[]>(
    (max, row) =>
      row.map((cell, index) => Math.max(max[index] ?? 0, cell.length)),
    [],
  );
  return rows
    .map((row) =>
      row
        .map((cell, index) =>
          index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0),
        )
        .join("  "),
    )
    .join("\n");
}

function envelope(
  warnings: Warning[],
  data: Record<string, unknown>,
  error: ReportError | undefined,
  details: Record<string, unknown>,
): Record<string, unknown> {
  if (!error) return { ok: true, warnings, ...data };
  const { code, message, hint } = error;
  return {
    ok: false,
    warnings,
    ...data,
    error: {
      code,
      message,
      hint,
      details: error.blocks?.length ? details : undefined,
    },
  };
}
