import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import {
  COMMANDS,
  PROGRAM,
  renderCommandsReference,
  SKILL_FOLDERS,
} from "../../scripts/skills-refs.ts";
import { ERROR_CODES } from "../../src/errors/index.ts";
import { CODEBASE_CHECK_IDS } from "../../src/services/doctor-checks.ts";
import {
  checkCliNames,
  checkCodeTokens,
  checkFrontmatter,
  commandPaths,
} from "../helpers/skills.ts";

const repo = new URL("../../", import.meta.url);
const skillsDir = new URL("skills/", repo);
const EXPECTED_SKILLS = [...SKILL_FOLDERS].sort();
// The CLI has no list of its warning codes; these are the ones it emits.
const WARNING_CODES = [
  "unknown-config-key",
  "stale-lock",
  "branch-not-merged",
  "hook-failed",
];
// Kebab-case words in skills that are not codes: the hook names.
const ALLOWED_WORDS = [
  "pre-create",
  "post-create",
  "pre-remove",
  "post-remove",
];
const KNOWN_TOKENS = new Set<string>([
  ...ERROR_CODES,
  ...WARNING_CODES,
  ...CODEBASE_CHECK_IDS,
  ...ALLOWED_WORDS,
]);

const paths = commandPaths(PROGRAM);

const skillFolders = existsSync(skillsDir)
  ? readdirSync(skillsDir)
      .filter((entry) => statSync(new URL(entry, skillsDir)).isDirectory())
      .sort()
  : [];

function readRepoFile(path: string): string | undefined {
  const url = new URL(path, repo);
  return existsSync(url) ? readFileSync(url, "utf8") : undefined;
}

const VALID = `---
name: demo
description: Runs xr for the user. Use when the user asks to sync a project.
license: MIT
---

# demo

Run \`xr project sync <project> --json --no-interactive\`.
`;

describe("skills/", () => {
  test(`has exactly the skills ${EXPECTED_SKILLS.join(", ")}`, () => {
    expect(skillFolders).toEqual(EXPECTED_SKILLS);
  });

  for (const folder of skillFolders) {
    const file = `skills/${folder}/SKILL.md`;
    const text = readRepoFile(file);

    describe(file, () => {
      test("exists", () => {
        expect(text).toBeDefined();
      });

      test("has valid frontmatter and fewer than 500 lines", () => {
        expect(checkFrontmatter(file, folder, text ?? "")).toEqual([]);
      });

      test("names only real xr commands and error codes", () => {
        expect(checkCliNames(file, text ?? "", paths)).toEqual([]);
      });

      test("names only real codes and check ids in backticks", () => {
        expect(checkCodeTokens(file, text ?? "", KNOWN_TOKENS)).toEqual([]);
      });
    });
  }
});

describe(".claude-plugin/", () => {
  const read = (file: string) => JSON.parse(readRepoFile(file) ?? "null");

  test(".claude-plugin/marketplace.json has a description and lists the one root plugin xr", () => {
    const marketplace = read(".claude-plugin/marketplace.json");
    expect(marketplace).toMatchObject({
      name: "xr",
      description: expect.any(String),
      owner: { name: expect.any(String) },
      plugins: [{ name: "xr", source: "./" }],
    });
    expect(marketplace.plugins).toHaveLength(1);
  });

  test(".claude-plugin/plugin.json has name xr, a description and license MIT", () => {
    expect(read(".claude-plugin/plugin.json")).toMatchObject({
      name: "xr",
      description: expect.any(String),
      license: "MIT",
    });
  });
});

describe("commandPaths", () => {
  test("lists nested command paths of createProgram", () => {
    expect(paths.has("project sync")).toBe(true);
    expect(paths.has("codebase repo add")).toBe(true);
    expect(paths.get("project")?.has("sync")).toBe(true);
  });
});

describe("checkFrontmatter on fixtures", () => {
  test("accepts a valid skill", () => {
    expect(checkFrontmatter("s/demo/SKILL.md", "demo", VALID)).toEqual([]);
  });

  test("reports a name that is not the folder name", () => {
    expect(checkFrontmatter("s/other/SKILL.md", "other", VALID)).toEqual([
      's/other/SKILL.md:1: name "demo" is not the folder name "other"',
    ]);
  });

  test("reports an extra model key", () => {
    const text = VALID.replace("license: MIT", "license: MIT\nmodel: sonnet");
    expect(checkFrontmatter("s/demo/SKILL.md", "demo", text)).toEqual([
      's/demo/SKILL.md:1: frontmatter key "model" is not allowed',
    ]);
  });

  test("reports a description over 1024 characters and one with <", () => {
    const long = VALID.replace(
      /description: .*/,
      `description: ${"a".repeat(1025)}`,
    );
    const angle = VALID.replace(
      /description: .*/,
      "description: Use for <project> work.",
    );
    expect(checkFrontmatter("f", "demo", long)).toEqual([
      "f:1: description has more than 1024 characters",
    ]);
    expect(checkFrontmatter("f", "demo", angle)).toEqual([
      "f:1: description has a < or > character",
    ]);
  });

  test("reports a license that is not MIT, a missing key and a bad name", () => {
    const text = VALID.replace("license: MIT", "license: ISC").replace(
      "name: demo",
      "name: Demo_X",
    );
    expect(checkFrontmatter("f", "Demo_X", text)).toEqual([
      'f:1: name "Demo_X" does not match /^[a-z0-9]+(-[a-z0-9]+)*$/',
      'f:1: license "ISC" is not MIT',
    ]);
    expect(
      checkFrontmatter("f", "demo", VALID.replace("license: MIT\n", "")),
    ).toEqual(['f:1: frontmatter has no "license"']);
  });

  test("reports a file of 500 lines or more", () => {
    const text = VALID + "line\n".repeat(500);
    expect(checkFrontmatter("f", "demo", text)).toEqual([
      "f:1: has 509 lines, not fewer than 500",
    ]);
  });
});

describe("checkCliNames on fixtures", () => {
  const check = (text: string) => checkCliNames("f", text, paths);

  test("accepts real commands with flags, args and plain prose", () => {
    const text = [
      "Run `xr --help` or `xr <command> --help`. Plain xr prose is fine.",
      "",
      "```sh",
      "xr codebase repo add <url> [name] --json",
      "xr project create feat/x api --json --no-interactive",
      "```",
    ].join("\n");
    expect(check(text)).toEqual([]);
  });

  test("reports a renamed command in inline code with its line", () => {
    expect(check("# t\n\nRun `xr project sinc --json`.\n")).toEqual([
      'f:3: unknown command "xr project sinc"',
    ]);
  });

  test("reports an unknown command in a code block with its line", () => {
    const text = "# t\n\n```sh\nxr codebase doctor\nxr codebase lint\n```\n";
    expect(check(text)).toEqual(['f:5: unknown command "xr codebase lint"']);
  });

  test("finds xr after $(, a quote or a backtick", () => {
    const text = [
      "```sh",
      'echo "$(xr project sinc --json)"',
      'sh -c "xr codebase lint"',
      "a=`xr project lst`",
      "```",
    ].join("\n");
    expect(check(text)).toEqual([
      'f:2: unknown command "xr project sinc"',
      'f:3: unknown command "xr codebase lint"',
      'f:4: unknown command "xr project lst"',
    ]);
  });
});

describe("checkCodeTokens on fixtures", () => {
  test("reports an unknown backticked kebab-case word with its line", () => {
    const text =
      "# t\n\nOn `already-codebase`, stop. Read `lock-held`, `--force` and `xr`.\n";
    expect(checkCodeTokens("f", text, new Set(["lock-held"]))).toEqual([
      'f:3: unknown code "already-codebase"',
    ]);
  });

  test("reports an unknown code in an Error codes table cell with its line", () => {
    const text = [
      "## Error codes",
      "",
      "| Code | Action |",
      "| --- | --- |",
      "| `lock-held` | Wait, then try again. |",
      "| `lock-busy` | Wait. |",
    ].join("\n");
    expect(checkCodeTokens("f", text, new Set(["lock-held"]))).toEqual([
      'f:6: unknown code "lock-busy"',
    ]);
  });
});

describe("skills/*/references/commands.md", () => {
  const expected = renderCommandsReference(COMMANDS);

  for (const skill of EXPECTED_SKILLS) {
    const dir = `skills/${skill}/references`;
    const file = `${dir}/commands.md`;
    const skillText = readRepoFile(`skills/${skill}/SKILL.md`) ?? "";

    test(`${file} is the --help text of every command`, () => {
      const problems =
        readRepoFile(file) === expected
          ? []
          : [
              `${file} differs from the xr --help text: run \`bun run skills:refs\``,
            ];
      expect(problems).toEqual([]);
    });

    test(`${dir} has only commands.md`, () => {
      const folder = new URL(`${dir}/`, repo);
      const found = existsSync(folder) ? readdirSync(folder).sort() : [];
      expect(found).toEqual(["commands.md"]);
    });

    test(`skills/${skill}/SKILL.md links ${file} once`, () => {
      expect(skillText.split("](references/commands.md)").length - 1).toBe(1);
    });
  }
});
