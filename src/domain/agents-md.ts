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
  const shift = text.startsWith("\uFEFF") ? 1 : 0;
  const headings = (fromMarkdown(text).children as MdNode[]).filter(
    (node) => node.type === "heading",
  );
  const sections: Sections = {};
  headings.forEach((heading, index) => {
    if (heading.depth !== 2) return;
    const title = textOf(heading).trim().toLowerCase();
    if (title !== "codebase" && title !== "repos") return;
    const key: keyof Sections = title;
    if (sections[key]) return;
    const next = headings
      .slice(index + 1)
      .find((node) => (node.depth ?? 0) <= 2);
    sections[key] = {
      start: offsetOf(heading) + shift,
      end: next ? offsetOf(next) + shift : text.length,
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

function textOf(node: MdNode): string {
  return node.value ?? (node.children ?? []).map(textOf).join("");
}

function offsetOf(node: MdNode): number {
  return node.position?.start.offset ?? 0;
}
