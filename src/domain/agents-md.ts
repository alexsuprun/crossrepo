import { fromMarkdown } from "mdast-util-from-markdown";

/** A character range `[start, end)` in the Markdown text. */
export interface Range {
  start: number;
  end: number;
}

/** The first `## Codebase` and `## Repos` sections of a Markdown text. */
export interface Sections {
  codebase?: Range;
  repos?: Range;
}

/** One repo line in the `## Codebase` section. */
export interface CodebaseRepo {
  name: string;
  description?: string;
}

/** One repo line in the project `## Codebase` section. */
export interface ProjectRepo {
  name: string;
  description?: string;
  /** The instruction file in the repo's worktree, when it has one. */
  instructions?: "AGENTS.md" | "CLAUDE.md";
}

interface MdNode {
  type: string;
  value?: string;
  depth?: number;
  children?: MdNode[];
  position?: { start: { offset?: number } };
}

/** `\r\n` when the text has any, else `\n`. */
export function detectEol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Finds the first depth 2 heading named `Codebase` and `Repos` (any case,
 * ATX or setext). A section runs to the next depth 1 or 2 heading, or to the end.
 */
export function findSections(text: string): Sections {
  // micromark drops a leading BOM, so its offsets are one short.
  const headings = headingsOf(text);
  const sections: Sections = {};
  headings.forEach((heading, index) => {
    if (heading.depth !== 2) return;
    const title = heading.title.toLowerCase();
    if (title !== "codebase" && title !== "repos") return;
    const key: keyof Sections = title;
    if (sections[key]) return;
    const next = headings.slice(index + 1).find((node) => node.depth <= 2);
    sections[key] = {
      start: heading.offset,
      end: next ? next.offset : text.length,
    };
  });
  return sections;
}

/**
 * Puts `section` in place of `range`, keeping every other byte. A section that
 * ends before another heading gets one blank line after it. With no range, the
 * section goes at the end after one blank line.
 */
export function spliceSection(
  text: string,
  range: Range | undefined,
  section: string,
): string {
  if (range === undefined) {
    const body = text.replace(/(\r?\n)+$/, "");
    return body === ""
      ? section
      : `${body}${detectEol(text).repeat(2)}${section}`;
  }
  const after = text.slice(range.end);
  const gap = after === "" ? "" : detectEol(section);
  return `${text.slice(0, range.start)}${section}${gap}${after}`;
}

/** Renders the `## Codebase` section, one line per repo in the given order. */
export function renderCodebaseSection(
  repos: readonly CodebaseRepo[],
  eol: string,
): string {
  const items =
    repos.length === 0
      ? ["- none"]
      : repos.map(({ name, description }) => {
          const text = description?.replace(/\s+/g, " ").trim();
          return text ? `- \`${name}\` — ${text}` : `- \`${name}\``;
        });
  return [
    "## Codebase",
    "",
    "This folder is a crossrepo codebase. `xr` writes this section, so do not edit it by hand.",
    "",
    "To start a project, run `xr project create <branch> <repo>...`. Run `xr --help` to see all commands.",
    "",
    "Repos:",
    "",
    ...items,
    "",
  ].join(eol);
}

/** Renders the project `## Codebase` section, one line per repo in the given order. */
export function renderProjectCodebaseSection(
  branch: string,
  repos: readonly ProjectRepo[],
  eol: string,
): string {
  const items =
    repos.length === 0
      ? ["- none"]
      : repos.map(({ name, description, instructions }) => {
          const label = instructions
            ? `[\`${name}\`](${name}/${instructions})`
            : `\`${name}\``;
          const text = description?.replace(/\s+/g, " ").trim();
          return text ? `- ${label} — ${text}` : `- ${label}`;
        });
  return [
    "## Codebase",
    "",
    `This folder is a crossrepo project for branch \`${branch}\`. \`xr\` writes this section, so do not edit it by hand.`,
    "",
    "Each repo is a git worktree on this branch. Run `xr --help` to see all commands.",
    "",
    "Repos:",
    "",
    ...items,
    "",
  ].join(eol);
}

/**
 * The project `## Repos` section made from the codebase text: its heading line
 * and the text before the first `###`, then each top-level `###` subsection
 * whose trimmed heading equals a repo name (case ignored), in file order. A
 * subsection runs to the next `###` or to the end of `## Repos`. With no
 * `## Repos`, only the heading. New line ends are `eol`.
 */
export function projectReposSection(
  codebaseText: string,
  repos: readonly string[],
  eol: string = detectEol(codebaseText),
): string {
  const range = findSections(codebaseText).repos;
  if (range === undefined) return `## Repos${eol}`;
  const names = new Set(repos.map((name) => name.toLowerCase()));
  const subs = headingsOf(codebaseText).filter(
    (h) => h.depth === 3 && h.offset > range.start && h.offset < range.end,
  );
  const chunks = [
    codebaseText.slice(range.start, subs[0]?.offset ?? range.end),
    ...subs
      .map((h, i) => ({ h, end: subs[i + 1]?.offset ?? range.end }))
      .filter(({ h }) => names.has(h.title.toLowerCase()))
      .map(({ h, end }) => codebaseText.slice(h.offset, end)),
  ];
  // Copied lines take the target line ending when the codebase file uses another one.
  const convert = eol !== detectEol(codebaseText);
  const kept = chunks.map((chunk) =>
    (convert ? chunk.replace(/\r?\n/g, eol) : chunk).replace(
      /(\r?\n[ \t]*)+$/,
      "",
    ),
  );
  return `${kept.join(eol.repeat(2))}${eol}`;
}

/**
 * Puts the project sections in place of `## Codebase` and `## Repos` of
 * `base`, keeping every other byte. A missing section goes at the end,
 * `## Codebase` first.
 */
export function spliceProjectSections(
  base: string,
  codebaseSection: string,
  reposSection: string,
): string {
  const text = spliceSection(
    base,
    findSections(base).codebase,
    codebaseSection,
  );
  return spliceSection(text, findSections(text).repos, reposSection);
}

interface Heading {
  depth: number;
  /** The heading text, trimmed. */
  title: string;
  offset: number;
}

/** The top-level headings, so a heading in a code block or a list does not count. */
function headingsOf(text: string): Heading[] {
  // micromark drops a leading BOM, so its offsets are one short.
  const shift = text.startsWith("\uFEFF") ? 1 : 0;
  return (fromMarkdown(text).children as MdNode[])
    .filter((node) => node.type === "heading")
    .map((node) => ({
      depth: node.depth ?? 0,
      title: textOf(node).trim(),
      offset: offsetOf(node) + shift,
    }));
}

function textOf(node: MdNode): string {
  return node.value ?? (node.children ?? []).map(textOf).join("");
}

function offsetOf(node: MdNode): number {
  return node.position?.start.offset ?? 0;
}
