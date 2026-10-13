import { describe, expect, test } from "bun:test";
import {
  detectEol,
  findSections,
  renderCodebaseSection,
  spliceSection,
} from "../../src/domain/agents-md.ts";

const SECTION = renderCodebaseSection([{ name: "api" }], "\n");

/** Finds `## Codebase` in `text` and splices in the rendered section. */
function write(text: string, section = SECTION): string {
  return spliceSection(text, findSections(text).codebase, section);
}

describe("renderCodebaseSection", () => {
  test("lists each repo in the given order, with the description when there is one", () => {
    expect(
      renderCodebaseSection(
        [
          { name: "web", description: "" },
          { name: "api", description: "Payments API" },
          { name: "cli" },
        ],
        "\n",
      ),
    ).toBe(
      [
        "## Codebase",
        "",
        "This folder is a crossrepo codebase. `xr` writes this section, so do not edit it by hand.",
        "",
        "To start a project, run `xr project create <branch> <repo>...`. Run `xr --help` to see all commands.",
        "",
        "Repos:",
        "",
        "- `web`",
        "- `api` — Payments API",
        "- `cli`",
        "",
      ].join("\n"),
    );
  });

  test("a description with newlines stays on one line, every whitespace run one space", () => {
    const text = renderCodebaseSection(
      [{ name: "api", description: "Pays\n## Repos\r\n\tand  bills\n" }],
      "\r\n",
    );
    expect(text).toEndWith("- `api` — Pays ## Repos and bills\r\n");
    expect(text.replaceAll("\r\n", "")).not.toContain("\n");
  });

  test("with no repos the list is one `- none` line", () => {
    expect(renderCodebaseSection([], "\n")).toEndWith("Repos:\n\n- none\n");
  });

  test("uses the given line ending on every line", () => {
    const text = renderCodebaseSection([{ name: "api" }], "\r\n");
    expect(text).toEndWith("- `api`\r\n");
    expect(text.replaceAll("\r\n", "")).not.toContain("\n");
  });
});

describe("detectEol", () => {
  test("is \\r\\n when the text has any, else \\n", () => {
    expect(detectEol("a\nb\r\nc\n")).toBe("\r\n");
    expect(detectEol("a\nb\n")).toBe("\n");
    expect(detectEol("")).toBe("\n");
  });
});

describe("findSections", () => {
  test("a section runs from its heading to the next depth 1 or 2 heading", () => {
    const text = "# Top\n\n## Codebase\n\nold\n\n## Repos\n\nr\n\n# End\n";
    expect(findSections(text)).toEqual({
      codebase: { start: 7, end: 25 },
      repos: { start: 25, end: 38 },
    });
  });

  test("a section with no later heading runs to the end of the file", () => {
    const text = "## Codebase\n\nold\n";
    expect(findSections(text)).toEqual({
      codebase: { start: 0, end: text.length },
    });
  });

  test("a setext heading counts", () => {
    expect(findSections("Codebase\n---\n\nold\n").codebase).toEqual({
      start: 0,
      end: 18,
    });
  });

  test("a depth 1 or 3 heading with the name does not count", () => {
    expect(findSections("# Codebase\n\n### Repos\n")).toEqual({});
  });

  test("a heading inside a fenced code block does not count", () => {
    expect(findSections("```md\n## Codebase\n```\n")).toEqual({});
  });
});

describe("splice the codebase section", () => {
  test("replace: only the section range changes, one blank line before the next heading", () => {
    const before = "# Notes for agents\n\nKeep this.\n\n";
    const after = "## Notes\n\nKeep this too.\n";
    const text = `${before}## Codebase\n\nold text\n\n\n${after}`;
    expect(write(text)).toBe(`${before}${SECTION}\n${after}`);
  });

  test("mixed case: `## CODEBASE` is the section and is replaced", () => {
    expect(write("## CODEBASE\n\nold\n")).toBe(SECTION);
  });

  test("code block: a heading only in a fenced block does not count, the section is appended", () => {
    const text = "Intro\n\n```md\n## Codebase\n```\n";
    expect(write(text)).toBe(`${text}\n${SECTION}`);
  });

  test("a `####` heading inside the section is part of it and is replaced", () => {
    expect(write("## Codebase\n\n#### x\n\nold\n\n## Repos\n\nr\n")).toBe(
      `${SECTION}\n## Repos\n\nr\n`,
    );
  });

  test("missing section: appended at the end after one blank line", () => {
    expect(write("# Agents\n\nRules.\n")).toBe(
      `# Agents\n\nRules.\n\n${SECTION}`,
    );
    expect(write("# Agents\n\nRules.")).toBe(
      `# Agents\n\nRules.\n\n${SECTION}`,
    );
    expect(write("# Agents\n\nRules.\n\n\n")).toBe(
      `# Agents\n\nRules.\n\n${SECTION}`,
    );
  });

  test("empty text: the result is only the section", () => {
    expect(write("")).toBe(SECTION);
  });

  test("CRLF: the new section uses \\r\\n and every other byte stays", () => {
    const before = "# Agents\r\n\r\nRules.\r\n\r\n";
    const after = "## Notes\r\n\r\nn\r\n";
    const text = `${before}## Codebase\r\n\r\nold\r\n\r\n${after}`;
    const section = renderCodebaseSection([{ name: "api" }], detectEol(text));
    expect(write(text, section)).toBe(`${before}${section}\r\n${after}`);
  });

  test("a leading BOM: offsets count it and no byte before the heading is lost", () => {
    const text = "\uFEFF# A\n\n## Codebase\n\nold\n\n## Repos\n\nr\n";
    expect(findSections(text)).toEqual({
      codebase: { start: 6, end: 24 },
      repos: { start: 24, end: 36 },
    });
    expect(write(text)).toBe(`\uFEFF# A\n\n${SECTION}\n## Repos\n\nr\n`);
  });

  test("`## Repos` and other sections stay byte for byte", () => {
    const repos = "## Repos\n\n- custom  \n\n";
    const text = `${repos}## Codebase\n\nold\n`;
    expect(write(text)).toBe(`${repos}${SECTION}`);
  });

  test("with two `## Codebase` sections only the first changes", () => {
    const text = "## Codebase\n\nfirst\n\n## Codebase\n\nsecond\n";
    expect(write(text)).toBe(`${SECTION}\n## Codebase\n\nsecond\n`);
  });

  test("a heading with inline code or emphasis matches on its text", () => {
    expect(findSections("## *Codebase*\n").codebase).toEqual({
      start: 0,
      end: 14,
    });
    expect(findSections("## `Repos`\n").repos).toEqual({ start: 0, end: 11 });
  });
});
