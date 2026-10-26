import { describe, expect, test } from "bun:test";
import {
  detectEol,
  findSections,
  projectReposSection,
  renderCodebaseSection,
  renderProjectCodebaseSection,
  repoHeadings,
  spliceProjectSections,
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

describe("renderProjectCodebaseSection", () => {
  test("names the branch and links each repo to its instruction file, relative with `/`", () => {
    expect(
      renderProjectCodebaseSection(
        "feat/x",
        [
          {
            name: "api",
            description: "The HTTP API",
            instructions: "AGENTS.md",
          },
          { name: "web", description: "", instructions: "CLAUDE.md" },
          { name: "cli", description: "Command\n  line" },
          { name: "docs" },
        ],
        "\n",
      ),
    ).toBe(
      [
        "## Codebase",
        "",
        "This folder is a crossrepo project for branch `feat/x`. `xr` writes this section, so do not edit it by hand.",
        "",
        "Each repo is a git worktree on this branch. Run `xr --help` to see all commands.",
        "",
        "Repos:",
        "",
        "- [`api`](api/AGENTS.md) — The HTTP API",
        "- [`web`](web/CLAUDE.md)",
        "- `cli` — Command line",
        "- `docs`",
        "",
      ].join("\n"),
    );
  });

  test("with no repos the list is one `- none` line", () => {
    expect(renderProjectCodebaseSection("main", [], "\n")).toEndWith(
      "Repos:\n\n- none\n",
    );
  });

  test("uses the given line ending on every line", () => {
    const text = renderProjectCodebaseSection(
      "main",
      [{ name: "api" }],
      "\r\n",
    );
    expect(text).toEndWith("- `api`\r\n");
    expect(text.replaceAll("\r\n", "")).not.toContain("\n");
  });
});

describe("projectReposSection", () => {
  const FULL = [
    "# Agents",
    "",
    "Intro.",
    "",
    "## Codebase",
    "",
    "old",
    "",
    "## Repos",
    "",
    "Notes for every repo.",
    "",
    "### API",
    "",
    "api text",
    "",
    "### web",
    "",
    "web text",
    "",
    "### docs",
    "",
    "docs text",
    "",
    "## Other",
    "",
    "other",
    "",
  ].join("\n");

  test("keeps the heading, the preamble and the matching subsections (case ignored)", () => {
    expect(projectReposSection(FULL, ["web", "api"])).toBe(
      "## Repos\n\nNotes for every repo.\n\n### API\n\napi text\n\n### web\n\nweb text\n",
    );
  });

  test("two subsections for one repo: both kept, in file order", () => {
    const text =
      "## Repos\n\n### api\n\none\n\n### web\n\nw\n\n###  Api \n\ntwo\n";
    expect(projectReposSection(text, ["api"])).toBe(
      "## Repos\n\n### api\n\none\n\n###  Api \n\ntwo\n",
    );
  });

  test("a subsection that ends in a spaces-only line loses that line", () => {
    const text = "## Repos\n\n### a\n\nx\n   \n\t\n### b\n\ny\n";
    expect(projectReposSection(text, ["a", "b"])).toBe(
      "## Repos\n\n### a\n\nx\n\n### b\n\ny\n",
    );
  });

  test("a repo with no subsection gets no entry and no placeholder", () => {
    const text = "## Repos\n\nPre.\n\n### api\n\na\n";
    expect(projectReposSection(text, ["cli"])).toBe("## Repos\n\nPre.\n");
  });

  test("`####` headings and headings in a code block stay inside the subsection", () => {
    const api = "### api\n\n#### Notes\n\nn\n\n```md\n### web\n```\n\nafter";
    const text = `## Repos\n\n${api}\n\n### web\n\nw\n`;
    expect(projectReposSection(text, ["api"])).toBe(`## Repos\n\n${api}\n`);
  });

  test("a `#` heading ends the last subsection and the section", () => {
    const text = "## Repos\n\n### api\n\na\n\n# Appendix\n\n### web\n";
    expect(projectReposSection(text, ["api", "web"])).toBe(
      "## Repos\n\n### api\n\na\n",
    );
  });

  test("CRLF: new line ends are \\r\\n", () => {
    const text =
      "## Repos\r\n\r\nPre.\r\n\r\n### a\r\n\r\nx\r\n\r\n### b\r\n\r\ny\r\n";
    const section = projectReposSection(text, ["b"]);
    expect(section).toBe("## Repos\r\n\r\nPre.\r\n\r\n### b\r\n\r\ny\r\n");
  });

  test("no `## Repos` or no text: the heading only", () => {
    expect(projectReposSection("# A\n", ["api"])).toBe("## Repos\n");
    expect(projectReposSection("", [])).toBe("## Repos\n");
    expect(projectReposSection("# A\r\n", [])).toBe("## Repos\r\n");
  });

  test("a leading BOM does not shift the subsections", () => {
    expect(
      projectReposSection("\uFEFF## Repos\n\n### a\n\nx\n\n### b\n\ny\n", [
        "b",
      ]),
    ).toBe("## Repos\n\n### b\n\ny\n");
  });

  test("a different given eol: every line end of the result is that eol", () => {
    expect(
      projectReposSection("## Repos\n\nPre.\n\n### a\n\nx\ny\n", ["a"], "\r\n"),
    ).toBe("## Repos\r\n\r\nPre.\r\n\r\n### a\r\n\r\nx\r\ny\r\n");
  });

  test("a mixed codebase file with its own eol keeps its copied bytes", () => {
    const text = "## Repos\r\n\r\n### a\r\n\r\nx\ny\r\n";
    expect(projectReposSection(text, ["a"], "\r\n")).toBe(text);
  });
});

describe("spliceProjectSections", () => {
  const CB = renderProjectCodebaseSection("main", [{ name: "api" }], "\n");

  test("only `## Codebase` and `## Repos` change; every other byte stays", () => {
    const intro = "# Agents\n\nIntro.\n\n";
    const other = "## Other\n\nother\n";
    const base = `${intro}## Codebase\n\nold\n\n## Repos\n\nr\n\n${other}`;
    const repos = "## Repos\n\n### api\n";
    expect(spliceProjectSections(base, CB, repos)).toBe(
      `${intro}${CB}\n${repos}\n${other}`,
    );
  });

  test("`## Repos` before `## Codebase` keeps its place", () => {
    const base = "## Repos\n\nr\n\n## Codebase\n\nold\n";
    expect(spliceProjectSections(base, CB, "## Repos\n")).toBe(
      `## Repos\n\n${CB}`,
    );
  });

  test("both missing: `## Codebase`, then `## Repos`, at the end", () => {
    expect(spliceProjectSections("", CB, "## Repos\n")).toBe(
      `${CB}\n## Repos\n`,
    );
    expect(spliceProjectSections("# A\n", CB, "## Repos\n")).toBe(
      `# A\n\n${CB}\n## Repos\n`,
    );
  });

  test("no `## Repos`: the heading only is added at the end", () => {
    const base = "# A\n\n## Codebase\n\nold\n\n## Notes\n\nn\n";
    expect(spliceProjectSections(base, CB, "## Repos\n")).toBe(
      `# A\n\n${CB}\n## Notes\n\nn\n\n## Repos\n`,
    );
  });

  test("CRLF base: every new line end is \\r\\n", () => {
    const base =
      "# A\r\n\r\n## Codebase\r\n\r\nold\r\n\r\n## Repos\r\n\r\nr\r\n\r\n## Notes\r\n";
    const cb = renderProjectCodebaseSection("main", [{ name: "api" }], "\r\n");
    const text = spliceProjectSections(base, cb, "## Repos\r\n");
    expect(text).toBe(`# A\r\n\r\n${cb}\r\n## Repos\r\n\r\n## Notes\r\n`);
    expect(text.replaceAll("\r\n", "")).not.toContain("\n");
  });
});

describe("repoHeadings", () => {
  test("gives the trimmed ### titles under the first ## Repos, in file order", () => {
    const text = [
      "# Team",
      "",
      "### outside",
      "",
      "## Repos",
      "",
      "Intro.",
      "",
      "### API ",
      "",
      "#### deeper",
      "",
      "### old",
      "",
      "## Footer",
      "",
      "### after",
      "",
      "## Repos",
      "",
      "### second",
      "",
    ].join("\n");
    expect(repoHeadings(text)).toEqual(["API", "old"]);
  });

  test("ignores a ### heading in a code block", () => {
    const text = "## Repos\n\n```\n### fake\n```\n\n### web\n";
    expect(repoHeadings(text)).toEqual(["web"]);
  });

  test("a ## Repos section with no ### gives an empty list", () => {
    expect(repoHeadings("## Repos\n\nNone yet.\n")).toEqual([]);
  });

  test("no ## Repos section gives undefined", () => {
    expect(repoHeadings("# Team\n\n### api\n")).toBeUndefined();
    expect(repoHeadings("")).toBeUndefined();
  });
});
