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
 * A value in a block. In text modes a path shows relative to the codebase or `~`
 * (with `homeOnly`, relative to `~` only), and a code shows as a command. In
 * JSON a path is absolute and a code is a plain string.
 */
export type Text =
  | string
  | { path: string; homeOnly?: boolean }
  | { code: string };

/** A `table` cell. In text modes `true` shows as `✓` and `false` as `–`; JSON keeps the boolean. */
export type Cell = Text | boolean;

export type RepoStatus = "ok" | "skipped" | "failed" | "conflict";

export interface FieldItem {
  key: string;
  /** A list prints one item per indented line in text modes, and is an array in JSON. */
  value: Text | Text[];
  source?: Text;
  extra?: Record<string, Text>;
}

/** One repo of a per-repo command. */
export interface RepoItem {
  repo: string;
  status: RepoStatus;
  message?: Text;
  hint?: Text;
  /** Where the branch of a new worktree came from: `local`, `tracking` or `new`. JSON only. */
  source?: string;
  /** `xr project remove --delete-branch` deleted the branch. JSON only. */
  branchDeleted?: boolean;
}

/** One project of a `projects` block. */
export interface ProjectItem {
  project: string;
  branch: string;
  path: Text;
  /** In record order. */
  repos: string[];
  /** ISO 8601 UTC; `null` in JSON when absent. */
  created?: string;
}

/** One repo of a `project` block: `present` when its worktree folder exists. */
export interface ProjectRepoItem {
  repo: string;
  path: Text;
  present: boolean;
}

/** One repo of a `project-repos` block: `present` when its worktree folder exists. */
export interface ProjectRepoEntry extends ProjectRepoItem {
  /** From the merged config; `null` in JSON when absent. */
  description?: string;
}

/** What a part of the Report is, never how it looks. The set is closed (AD-3). */
export type Block =
  /** A boolean or a number prints as `<key>: <value>` in text modes; JSON keeps its type. */
  | { type: "value"; key: string; value: Text | boolean | number }
  | { type: "fields"; key: string; items: FieldItem[] }
  /** Rows of records. Each record has the same keys, which are the JSON field names. */
  | { type: "table"; key: string; items: Record<string, Cell>[] }
  /** One result per repo. In text modes a line like the live `repo` event, the hint muted under it. */
  | { type: "repos"; items: RepoItem[] }
  | { type: "checks"; items: { id: string; status: string; fix?: Text }[] }
  | {
      type: "leftovers";
      items: { what: string; path: Text; command: Text }[];
    }
  | { type: "section"; key: string; title: Text; blocks: Block[] }
  /** A list of parts prints them joined, on one line. */
  | { type: "note"; tone: Tone; text: Text | Text[] }
  /** Projects with their repos as child lines in text; `entries` in JSON. */
  | { type: "projects"; items: ProjectItem[] }
  /**
   * One project. Text: aligned label rows, `codebase` relative to `~` only, then
   * the repos. JSON: its fields as top-level keys.
   */
  | {
      type: "project";
      project: string;
      branch: string;
      path: Text;
      codebase: Text;
      created?: string;
      repos: ProjectRepoItem[];
    }
  /**
   * The repos of one project. Text: one line per repo, no header. JSON:
   * `project` and `entries` as top-level keys.
   */
  | { type: "project-repos"; project: string; entries: ProjectRepoEntry[] };

/** The error of a failed command. Same fields as `XrError`, which `output` may not import. */
export interface ReportError {
  code: string;
  message: string;
  hint?: string;
  /** Plain data for `error.details` in JSON. Text modes do not print it. */
  details?: Record<string, unknown>;
  /** Their data is `error.details` in JSON, next to `details`. */
  blocks?: Block[];
}

/** Live progress. Every event goes to stderr, in every mode. */
export type LiveEvent =
  | { type: "step-start"; text: string }
  | { type: "step-end"; text: string; ok: boolean }
  | {
      type: "repo";
      repo: string;
      status: RepoStatus;
      message?: string;
      hint?: string;
    }
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
  /** stdout and stderr are both a terminal, so the user sees both on one screen. */
  sameScreen?: boolean;
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
  sameScreen = false,
  home,
  codebase,
}: CreateOutputOptions): Output {
  const warnings: Warning[] = [];
  let repoLinesShown = false;
  const painter =
    (mode: Mode) =>
    (tone: Tone, text: string): string =>
      mode === "rich"
        ? styleText(TONE_FORMAT[tone], text, { validateStream: false })
        : text;
  const paint = painter(modes.stderr);
  const line = (text: string) => stderr(`${text}\n`);
  const show: Show = (text, { homeOnly = false } = {}) =>
    showText(
      text,
      home,
      homeOnly || (typeof text === "object" && "path" in text && text.homeOnly)
        ? undefined
        : codebase,
    );

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
        case "repo":
          repoLinesShown = true;
          line(renderRepo(event, paint, show));
          break;
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
      const details = error ? errorDetails(error) : {};
      if (modes.stdout === "json") {
        stdout(`${JSON.stringify(envelope(warnings, data, error, details))}\n`);
        return;
      }
      // Text never shows the live repo lines a second time on the same screen.
      const notShown = (onScreen: boolean) =>
        repoLinesShown && onScreen
          ? blocks.filter((block) => block.type !== "repos")
          : blocks;
      if (!error) {
        const text = renderBlocks(
          notShown(sameScreen),
          painter(modes.stdout),
          show,
        );
        if (text) stdout(text);
        return;
      }
      const shown = notShown(true);
      stderr(renderBlocks(shown, paint, show) + (shown.length ? "\n" : ""));
      line(`${paint("error", "error:")} ${error.message}`);
      if (error.hint) line(paint("muted", error.hint));
      if (error.blocks?.length) {
        stderr(`\n${renderBlocks(error.blocks, paint, show)}`);
      }
    },
  };
}

type Paint = (tone: Tone, text: string) => string;

/** Text-mode form of a value. `homeOnly` shows a path relative to `~`, never to the codebase. */
type Show = (text: Text, options?: { homeOnly?: boolean }) => string;

/** `error.details`: the plain details and the data of the error blocks. Throws on a key clash. */
function errorDetails({
  details = {},
  blocks = [],
}: ReportError): Record<string, unknown> {
  const data = blocksData(blocks, false);
  for (const key of Object.keys(details)) {
    if (Object.hasOwn(data, key)) {
      throw new Error(`The error has the key "${key}" twice.`);
    }
  }
  return { ...details, ...data };
}

/** The JSON data of `blocks`. Throws on a key clash, which is a bug in the command. */
function blocksData(
  blocks: readonly Block[],
  topLevel: boolean,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const notes = blocks.flatMap((block) =>
    block.type === "note" ? [parts(block.text).map(jsonText).join("")] : [],
  );
  for (const block of blocks) {
    if (block.type === "note") continue;
    for (const [key, value] of blockEntries(block)) {
      if (topLevel && RESERVED_KEYS.has(key)) {
        throw new Error(`The Report uses the reserved key "${key}".`);
      }
      if (Object.hasOwn(data, key)) {
        throw new Error(`The Report has the key "${key}" twice.`);
      }
      data[key] = value;
    }
  }
  if (notes.length) {
    if (Object.hasOwn(data, "notes")) {
      throw new Error('The Report has the key "notes" twice.');
    }
    data.notes = notes;
  }
  return data;
}

/** The JSON keys of a block: one key, or several for the flat `project` and `project-repos` blocks. */
function blockEntries(block: Block): [string, unknown][] {
  if (block.type === "project-repos") {
    return [
      ["project", block.project],
      [
        "entries",
        block.entries.map(({ repo, path, present, description }) => ({
          repo,
          path: jsonText(path),
          present,
          description: description ?? null,
        })),
      ],
    ];
  }
  if (block.type !== "project") return [blockData(block)];
  return [
    ["project", block.project],
    ["branch", block.branch],
    ["path", jsonText(block.path)],
    ["codebase", jsonText(block.codebase)],
    ["created", block.created ?? null],
    [
      "repos",
      block.repos.map(({ repo, path, present }) => ({
        repo,
        path: jsonText(path),
        present,
      })),
    ],
  ];
}

function blockData(block: Block): [string, unknown] {
  switch (block.type) {
    case "value":
      return [block.key, jsonCell(block.value)];
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
      return [block.key, block.items.map((item) => mapValues(item, jsonCell))];
    case "repos":
      return [
        "repos",
        block.items.map(
          ({ repo, status, message, hint, source, branchDeleted }) => ({
            repo,
            status,
            ...(message === undefined ? {} : { message: jsonText(message) }),
            ...(hint === undefined ? {} : { hint: jsonText(hint) }),
            ...(source === undefined ? {} : { source }),
            ...(branchDeleted === undefined ? {} : { branchDeleted }),
          }),
        ),
      ];
    case "leftovers":
      return [
        "leftovers",
        block.items.map(({ what, path, command }) => ({
          what,
          path: jsonText(path),
          command: jsonText(command),
        })),
      ];
    case "section":
      return [block.key, blocksData(block.blocks, false)];
    case "projects":
      return [
        "entries",
        block.items.map(({ project, branch, path, repos, created }) => ({
          project,
          branch,
          path: jsonText(path),
          repos,
          created: created ?? null,
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

function jsonCell(cell: Text | boolean | number): string | boolean | number {
  return typeof cell === "boolean" || typeof cell === "number"
    ? cell
    : jsonText(cell);
}

function parts(text: Text | Text[]): Text[] {
  return Array.isArray(text) ? text : [text];
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
  show: Show,
): string {
  return blocks
    .filter(
      (block) =>
        (block.type !== "table" &&
          block.type !== "repos" &&
          block.type !== "projects") ||
        block.items.length > 0,
    )
    .map((block) => `${renderBlock(block, paint, show)}\n`)
    .join("\n");
}

function renderBlock(block: Block, paint: Paint, show: Show): string {
  switch (block.type) {
    case "value":
      return typeof block.value === "boolean" || typeof block.value === "number"
        ? `${block.key}: ${block.value}`
        : show(block.value).replace(/\n$/, "");
    case "fields":
      return renderFields(block.items, paint, show);
    case "table":
      return renderTable(block.items, paint, show);
    case "note":
      return paint(
        block.tone,
        parts(block.text)
          .map((part) => show(part))
          .join(""),
      );
    case "repos":
      return block.items
        .map((item) => renderRepo(item, paint, show))
        .join("\n");
    case "leftovers":
      return block.items
        .map(
          ({ what, path, command }) =>
            `${what}: ${show(path)}\n${paint("muted", `  ${show(command)}`)}`,
        )
        .join("\n");
    case "section": {
      const inner = renderBlocks(block.blocks, paint, show).replace(/\n$/, "");
      const indented = inner
        .split("\n")
        .map((text) => (text ? `  ${text}` : text))
        .join("\n");
      return inner ? `${show(block.title)}\n${indented}` : show(block.title);
    }
    case "projects":
      return renderProjects(block.items, show);
    case "project":
      return renderProject(block, paint, show);
    case "project-repos":
      return renderProjectRepos(block.entries, paint);
    default:
      return noRenderer(block);
  }
}

/** `<symbol> <repo>[: <message>]`, and the hint muted on the next line. */
function renderRepo(
  { repo, status, message, hint }: RepoItem,
  paint: Paint,
  show: Show,
): string {
  const { symbol, tone } = REPO_LOOK[status];
  const tail = message ? `: ${show(message)}` : "";
  const head = `${paint(tone, symbol)} ${repo}${tail}`;
  return hint ? `${head}\n${paint("muted", `  ${show(hint)}`)}` : head;
}

/** One aligned `name  branch  date` row per project, then one indented line per repo. */
function renderProjects(items: readonly ProjectItem[], show: Show): string {
  const projectWidth = Math.max(...items.map(({ project }) => project.length));
  const branchWidth = Math.max(...items.map(({ branch }) => branch.length));
  return items
    .map(({ project, branch, repos, created }) =>
      [
        [
          project.padEnd(projectWidth),
          branch.padEnd(branchWidth),
          created?.slice(0, 10) ?? "",
        ]
          .join("  ")
          .trimEnd(),
        ...repos.map((repo) => `  ${show(repo)}`),
      ].join("\n"),
    )
    .join("\n");
}

/** Aligned label rows, then `repos` with `✓` or `–` per repo. */
function renderProject(
  block: Extract<Block, { type: "project" }>,
  paint: Paint,
  show: Show,
): string {
  const rows: [string, string][] = [
    ["project", block.project],
    ["branch", block.branch],
    ["path", show(block.path)],
    ["codebase", show(block.codebase, { homeOnly: true })],
    ["created", block.created ?? ""],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  const repoWidth = Math.max(0, ...block.repos.map(({ repo }) => repo.length));
  return [
    ...rows.map(([label, value]) =>
      value ? `${label.padEnd(width)}  ${value}` : label,
    ),
    "repos",
    ...block.repos.map(({ repo, present }) =>
      present
        ? `  ${paint("ok", SYMBOL.ok)} ${repo}`
        : `  ${paint("muted", SYMBOL.skipped)} ${repo.padEnd(repoWidth)}   ${paint("warn", "worktree folder missing")}`,
    ),
  ].join("\n");
}

/** One line per repo: `✓` or `–`, the padded name, then the description or "worktree folder missing". */
function renderProjectRepos(
  entries: readonly ProjectRepoEntry[],
  paint: Paint,
): string {
  const width = Math.max(0, ...entries.map(({ repo }) => repo.length));
  return entries
    .map(({ repo, present, description }) =>
      present
        ? `${paint("ok", SYMBOL.ok)} ${`${repo.padEnd(width)}   ${description ?? ""}`.trimEnd()}`
        : `${paint("muted", SYMBOL.skipped)} ${repo.padEnd(width)}   ${paint("warn", "worktree folder missing")}`,
    )
    .join("\n");
}

function renderFields(
  items: readonly FieldItem[],
  paint: Paint,
  show: Show,
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

/**
 * One row per record, columns padded to the widest cell; the last column is not padded.
 * Boolean cells show as `✓`/`–`, painted in rich mode; padding is measured on the unpainted text.
 */
function renderTable(
  items: readonly Record<string, Cell>[],
  paint: Paint,
  show: Show,
): string {
  const rows = items.map((item) =>
    Object.values(item).map((cell) => showCell(cell, show)),
  );
  const widths = rows.reduce<number[]>(
    (max, row) =>
      row.map((cell, index) => Math.max(max[index] ?? 0, cell.text.length)),
    [],
  );
  return rows
    .map((row) =>
      row
        .map(({ text, tone }, index) => {
          const shown = tone ? paint(tone, text) : text;
          return index === row.length - 1
            ? shown
            : shown + " ".repeat((widths[index] ?? 0) - text.length);
        })
        .join("  "),
    )
    .join("\n");
}

function showCell(cell: Cell, show: Show): { text: string; tone?: Tone } {
  if (cell === true) return { text: SYMBOL.ok, tone: "ok" };
  if (cell === false) return { text: SYMBOL.skipped, tone: "muted" };
  return { text: show(cell) };
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
      details: Object.keys(details).length ? details : undefined,
    },
  };
}
