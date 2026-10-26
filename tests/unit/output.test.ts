import { describe, expect, test } from "bun:test";
import { join, sep } from "node:path";
import { styleText } from "node:util";
import {
  type Block,
  createOutput,
  type Mode,
  pickModes,
  type TextMode,
} from "../../src/output/index.ts";

const ESC = "\u001b[";

describe("pickModes", () => {
  function stdoutMode(
    env: Record<string, string | undefined>,
    isTTY: boolean,
    json = false,
  ): Mode {
    return pickModes({ json, env, isTTY: { stdout: isTTY, stderr: isTTY } })
      .stdout;
  }

  test("--json makes stdout json, even on a TTY with FORCE_COLOR", () => {
    expect(stdoutMode({ FORCE_COLOR: "1" }, true, true)).toBe("json");
  });

  test("--json never makes stderr json", () => {
    const modes = pickModes({
      json: true,
      env: {},
      isTTY: { stdout: false, stderr: true },
    });
    expect(modes).toEqual({ stdout: "json", stderr: "rich" });
  });

  test("FORCE_COLOR set to '', 1, 2, 3 or true is rich, and wins over NO_COLOR and TERM=dumb", () => {
    for (const value of ["", "1", "2", "3", "true"]) {
      expect(
        stdoutMode({ FORCE_COLOR: value, NO_COLOR: "1", TERM: "dumb" }, false),
      ).toBe("rich");
    }
  });

  test("FORCE_COLOR set to any other value is plain, even on a TTY, the same as Node", () => {
    for (const value of ["0", "false", "yes"]) {
      expect(stdoutMode({ FORCE_COLOR: value }, true)).toBe("plain");
    }
  });

  test("NO_COLOR set and not empty is plain on a TTY", () => {
    expect(stdoutMode({ NO_COLOR: "1" }, true)).toBe("plain");
    expect(stdoutMode({ NO_COLOR: "" }, true)).toBe("rich");
  });

  test("TERM=dumb is plain on a TTY", () => {
    expect(stdoutMode({ TERM: "dumb" }, true)).toBe("plain");
  });

  test("a TTY is rich and anything else is plain", () => {
    expect(stdoutMode({}, true)).toBe("rich");
    expect(stdoutMode({}, false)).toBe("plain");
  });

  test("each stream gets its own mode", () => {
    expect(
      pickModes({
        json: false,
        env: {},
        isTTY: { stdout: false, stderr: true },
      }),
    ).toEqual({ stdout: "plain", stderr: "rich" });
  });
});

const HOME = join(sep, "home", "me");
const CODEBASE = join(HOME, "code", "shop");

function capture(
  stdoutMode: Mode,
  stderrMode: TextMode = "plain",
  codebase: string | null = CODEBASE,
  sameScreen = false,
) {
  const written = { stdout: "", stderr: "" };
  const out = createOutput({
    modes: { stdout: stdoutMode, stderr: stderrMode },
    sameScreen,
    home: HOME,
    codebase: codebase ?? undefined,
    stdout: (text) => {
      written.stdout += text;
    },
    stderr: (text) => {
      written.stderr += text;
    },
  });
  return { out, written };
}

describe("live events", () => {
  test("go to stderr with the symbols, in every mode", () => {
    for (const mode of ["plain", "json"] as const) {
      const { out, written } = capture(mode);
      out.emit({ type: "step-start", text: "Fetch api" });
      out.emit({ type: "step-end", text: "Fetch api", ok: true });
      out.emit({ type: "step-end", text: "Fetch web", ok: false });
      out.emit({ type: "repo", repo: "api", status: "ok" });
      out.emit({ type: "repo", repo: "web", status: "skipped" });
      out.emit({
        type: "repo",
        repo: "docs",
        status: "failed",
        message: "no remote",
      });
      out.emit({ type: "repo", repo: "cli", status: "conflict" });
      out.emit({
        type: "repo",
        repo: "ui",
        status: "failed",
        message: "folder has no .git",
        hint: "Move or delete it.",
      });
      expect(written.stdout).toBe("");
      expect(written.stderr).toBe(
        [
          "Fetch api…",
          "✓ Fetch api",
          "✗ Fetch web",
          "✓ api",
          "– web",
          "✗ docs: no remote",
          "! cli",
          "✗ ui: folder has no .git",
          "  Move or delete it.",
          "",
        ].join("\n"),
      );
    }
  });

  test("a warning goes live to stderr with its hint", () => {
    const { out, written } = capture("plain");
    out.emit({
      type: "warning",
      warning: { code: "unknown-config-key", message: "bad key", hint: "Fix" },
    });
    expect(written.stderr).toBe("! bad key\n  Fix\n");
    expect(written.stdout).toBe("");
  });

  test("rich stderr styles with ANSI codes, plain has none", () => {
    const rich = capture("plain", "rich");
    rich.out.emit({ type: "step-end", text: "Fetch", ok: true });
    expect(rich.written.stderr).toContain(ESC);
    expect(rich.written.stderr).toContain("✓");

    const plain = capture("rich", "plain");
    plain.out.emit({ type: "step-end", text: "Fetch", ok: true });
    expect(plain.written.stderr).not.toContain(ESC);
  });
});

describe("trace", () => {
  test("goes to stderr only", () => {
    const { out, written } = capture("json");
    out.trace("Error: boom\n    at x");
    expect(written).toEqual({ stdout: "", stderr: "Error: boom\n    at x\n" });
  });
});

const version: Block = { type: "value", key: "version", value: "1.2.3" };

const entries: Block = {
  type: "fields",
  key: "entries",
  items: [
    {
      key: "name",
      value: "shop",
      source: { path: join(CODEBASE, ".crossrepo", "config.yaml") },
    },
    {
      key: "projects-dir",
      value: "~/p",
      source: { path: join(HOME, ".crossrepo", "config.yaml") },
      extra: { resolved: { path: join(HOME, "p") } },
    },
    {
      key: "project.post-create",
      value: ["npm ci", { code: "cp .env x" }],
      source: { path: join(sep, "etc", "x.yaml") },
    },
    { key: "repos.api.remote", value: "git@h:api.git" },
  ],
};

describe("report in json mode", () => {
  test("is exactly one JSON object on stdout with ok and warnings", () => {
    const { out, written } = capture("json");
    out.report({ blocks: [version] });
    expect(written.stderr).toBe("");
    expect(written.stdout.endsWith("\n")).toBe(true);
    expect(written.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(written.stdout).toBe(
      '{"ok":true,"warnings":[],"version":"1.2.3"}\n',
    );
  });

  test("lists every warning emitted before the report", () => {
    const { out, written } = capture("json");
    out.emit({
      type: "warning",
      warning: { code: "a", message: "first", hint: "h" },
    });
    out.emit({ type: "warning", warning: { code: "b", message: "second" } });
    out.report({ blocks: [] });
    expect(JSON.parse(written.stdout)).toEqual({
      ok: true,
      warnings: [
        { code: "a", message: "first", hint: "h" },
        { code: "b", message: "second" },
      ],
    });
    expect(written.stderr).toBe("! first\n  h\n! second\n");
  });

  test("a fields block is a list with absolute paths, plain codes and extra spread in", () => {
    const { out, written } = capture("json");
    out.report({ blocks: [entries] });
    expect(JSON.parse(written.stdout)).toEqual({
      ok: true,
      warnings: [],
      entries: [
        {
          key: "name",
          value: "shop",
          source: join(CODEBASE, ".crossrepo", "config.yaml"),
        },
        {
          key: "projects-dir",
          value: "~/p",
          source: join(HOME, ".crossrepo", "config.yaml"),
          resolved: join(HOME, "p"),
        },
        {
          key: "project.post-create",
          value: ["npm ci", "cp .env x"],
          source: join(sep, "etc", "x.yaml"),
        },
        { key: "repos.api.remote", value: "git@h:api.git" },
      ],
    });
  });

  test("a failure has ok false and the error with only the fields it has", () => {
    const { out, written } = capture("json");
    out.report({
      blocks: [],
      error: { code: "internal", message: "boom", hint: undefined },
    });
    expect(written.stdout).toBe(
      '{"ok":false,"warnings":[],"error":{"code":"internal","message":"boom"}}\n',
    );
    expect(written.stderr).toBe("");
  });

  test("a failure keeps the hint, the report blocks, and the error blocks as details", () => {
    const { out, written } = capture("json");
    out.report({
      blocks: [version],
      error: {
        code: "repos-failed",
        message: "1 repo failed",
        hint: "Run again.",
        blocks: [{ type: "value", key: "failed", value: "api" }],
      },
    });
    expect(JSON.parse(written.stdout)).toEqual({
      ok: false,
      warnings: [],
      version: "1.2.3",
      error: {
        code: "repos-failed",
        message: "1 repo failed",
        hint: "Run again.",
        details: { failed: "api" },
      },
    });
  });
});

describe("report keys", () => {
  for (const key of ["ok", "warnings", "error"]) {
    test(`a block with the reserved key ${key} throws`, () => {
      const { out, written } = capture("json");
      expect(() =>
        out.report({ blocks: [{ type: "value", key, value: "x" }] }),
      ).toThrow(`reserved`);
      expect(written.stdout).toBe("");
    });
  }

  test("two blocks with one key throw, in every mode", () => {
    for (const mode of ["json", "plain"] as const) {
      const { out, written } = capture(mode);
      expect(() => out.report({ blocks: [version, version] })).toThrow(
        "version",
      );
      expect(written.stdout).toBe("");
    }
  });

  test("two error blocks with one key throw", () => {
    const { out } = capture("json");
    expect(() =>
      out.report({
        blocks: [],
        error: { code: "x", message: "y", blocks: [version, version] },
      }),
    ).toThrow("version");
  });

  test("an error block may use a reserved key, since it sits under details", () => {
    const { out, written } = capture("json");
    out.report({
      blocks: [],
      error: {
        code: "x",
        message: "y",
        blocks: [{ type: "value", key: "ok", value: "1" }],
      },
    });
    expect(JSON.parse(written.stdout).error.details).toEqual({ ok: "1" });
  });

  test("block types without a renderer yet throw", () => {
    const blocks: Block[] = [{ type: "checks", items: [] }];
    for (const block of blocks) {
      for (const mode of ["json", "plain"] as const) {
        const { out } = capture(mode);
        expect(() => out.report({ blocks: [block] })).toThrow(block.type);
      }
    }
  });
});

describe("report in text mode", () => {
  test("a value block prints the value alone on stdout and nothing on stderr", () => {
    const { out, written } = capture("plain");
    out.report({ blocks: [version] });
    expect(written).toEqual({ stdout: "1.2.3\n", stderr: "" });
  });

  test("a value that ends with a new line is not given a second one", () => {
    const { out, written } = capture("plain");
    out.report({ blocks: [{ type: "value", key: "help", value: "a\nb\n" }] });
    expect(written.stdout).toBe("a\nb\n");
  });

  test("puts one blank line between blocks", () => {
    const { out, written } = capture("plain");
    out.report({
      blocks: [version, { type: "value", key: "other", value: "x" }],
    });
    expect(written.stdout).toBe("1.2.3\n\nx\n");
  });

  test("an empty report prints nothing", () => {
    const { out, written } = capture("plain");
    out.report({ blocks: [] });
    expect(written).toEqual({ stdout: "", stderr: "" });
  });

  test("a fields block prints aligned key = value lines with extra and source after them", () => {
    const { out, written } = capture("plain");
    out.report({ blocks: [entries] });
    expect(written.stdout).toBe(
      [
        `name                = shop           ${join(".crossrepo", "config.yaml")}`,
        `projects-dir        = ~/p            resolved ${join("~", "p")}  ${join("~", ".crossrepo", "config.yaml")}`,
        `project.post-create =                ${join(sep, "etc", "x.yaml")}`,
        "  npm ci",
        "  cp .env x",
        "repos.api.remote    = git@h:api.git",
        "",
      ].join("\n"),
    );
  });

  test("a path is relative to the codebase, else to ~, else absolute", () => {
    const { out, written } = capture("plain");
    out.report({
      blocks: [
        {
          type: "fields",
          key: "f",
          items: [
            { key: "a", value: { path: CODEBASE } },
            { key: "b", value: { path: join(CODEBASE, "x") } },
            { key: "c", value: { path: HOME } },
            { key: "d", value: { path: join(HOME, "y") } },
            { key: "e", value: { path: join(sep, "opt") } },
            { key: "f", value: { path: `${CODEBASE}-other` } },
          ],
        },
      ],
    });
    expect(written.stdout).toBe(
      [
        "a = .",
        "b = x",
        "c = ~",
        `d = ${join("~", "y")}`,
        `e = ${join(sep, "opt")}`,
        `f = ${join("~", "code", "shop-other")}`,
        "",
      ].join("\n"),
    );
  });

  test("without a codebase a path is relative to ~ only", () => {
    const { out, written } = capture("plain", "plain", null);
    out.report({
      blocks: [
        { type: "value", key: "p", value: { path: join(CODEBASE, "x") } },
      ],
    });
    expect(written.stdout).toBe(`${join("~", "code", "shop", "x")}\n`);
  });

  test("rich stdout mutes extra and source and keeps the value plain", () => {
    const { out, written } = capture("rich");
    out.report({ blocks: [entries] });
    expect(written.stdout).toContain(ESC);
    expect(written.stdout).toContain("name                = shop");
  });

  test("plain stdout has no escape codes", () => {
    const { out, written } = capture("plain", "rich");
    out.report({ blocks: [entries] });
    expect(written.stdout).not.toContain(ESC);
  });

  test("prints nothing on stdout when the report has an error", () => {
    const { out, written } = capture("plain");
    out.report({
      blocks: [version],
      error: { code: "internal", message: "boom" },
    });
    expect(written).toEqual({ stdout: "", stderr: "1.2.3\n\nerror: boom\n" });
  });

  test("prints an error with its hint and then its blocks on stderr only", () => {
    const { out, written } = capture("plain");
    out.report({
      blocks: [],
      error: {
        code: "usage",
        message: "bad flag",
        hint: "Run it right.",
        blocks: [{ type: "value", key: "v", value: "detail" }],
      },
    });
    expect(written).toEqual({
      stdout: "",
      stderr: "error: bad flag\nRun it right.\n\ndetail\n",
    });
  });

  test("prints an error without a hint as one line", () => {
    const { out, written } = capture("rich", "plain");
    out.report({ blocks: [], error: { code: "internal", message: "boom" } });
    expect(written).toEqual({ stdout: "", stderr: "error: boom\n" });
  });

  test("styles the error on a rich stderr", () => {
    const { out, written } = capture("plain", "rich");
    out.report({
      blocks: [],
      error: { code: "usage", message: "bad", hint: "h" },
    });
    expect(written.stderr).toContain(ESC);
    expect(written.stderr).toContain("bad");
  });
});

const added: Block = {
  type: "table",
  key: "added",
  items: [
    { repo: "api", remote: "git@h:api.git", defaultBranch: "main" },
    {
      repo: "website",
      remote: { path: join(CODEBASE, "o") },
      defaultBranch: "trunk",
    },
  ],
};

const leftovers: Block = {
  type: "leftovers",
  items: [
    {
      what: ".crossrepo folder",
      path: { path: join(CODEBASE, ".crossrepo") },
      command: { code: "rm -r .crossrepo" },
    },
  ],
};

describe("table, note and leftovers blocks in json mode", () => {
  test("a table is a list of records with absolute paths", () => {
    const { out, written } = capture("json");
    out.report({ blocks: [added] });
    expect(JSON.parse(written.stdout)).toEqual({
      ok: true,
      warnings: [],
      added: [
        { repo: "api", remote: "git@h:api.git", defaultBranch: "main" },
        {
          repo: "website",
          remote: join(CODEBASE, "o"),
          defaultBranch: "trunk",
        },
      ],
    });
  });

  test("notes collect into one notes list, in order", () => {
    const { out, written } = capture("json");
    out.report({
      blocks: [
        { type: "note", tone: "muted", text: "first" },
        { type: "note", tone: "warn", text: { code: "xr x" } },
      ],
    });
    expect(JSON.parse(written.stdout).notes).toEqual(["first", "xr x"]);
  });

  test("a notes key next to a note block clashes", () => {
    const { out } = capture("json");
    expect(() =>
      out.report({
        blocks: [
          { type: "value", key: "notes", value: "x" },
          { type: "note", tone: "ok", text: "n" },
        ],
      }),
    ).toThrow("notes");
  });

  test("leftovers in an error block are error.details.leftovers", () => {
    const { out, written } = capture("json");
    out.report({
      blocks: [],
      error: { code: "git-failed", message: "m", blocks: [leftovers] },
    });
    expect(JSON.parse(written.stdout).error.details).toEqual({
      leftovers: [
        {
          what: ".crossrepo folder",
          path: join(CODEBASE, ".crossrepo"),
          command: "rm -r .crossrepo",
        },
      ],
    });
  });
});

describe("table, note and leftovers blocks in text mode", () => {
  test("a table prints one aligned row per record", () => {
    const { out, written } = capture("plain");
    out.report({ blocks: [added] });
    expect(written.stdout).toBe(
      [
        "api      git@h:api.git  main",
        "website  o              trunk",
        "",
      ].join("\n"),
    );
  });

  test("an empty table prints nothing", () => {
    const { out, written } = capture("plain");
    out.report({ blocks: [version, { type: "table", key: "t", items: [] }] });
    expect(written.stdout).toBe("1.2.3\n");
  });

  test("a note is one line, in its tone on a rich stream", () => {
    const plain = capture("plain");
    plain.out.report({ blocks: [{ type: "note", tone: "warn", text: "n" }] });
    expect(plain.written.stdout).toBe("n\n");
    const rich = capture("rich");
    rich.out.report({ blocks: [{ type: "note", tone: "warn", text: "n" }] });
    expect(rich.written.stdout).toContain(ESC);
  });

  test("leftovers print what and path, then the command under them", () => {
    const { out, written } = capture("plain");
    out.report({
      blocks: [],
      error: { code: "git-failed", message: "m", blocks: [leftovers] },
    });
    expect(written.stderr).toBe(
      "error: m\n\n.crossrepo folder: .crossrepo\n  rm -r .crossrepo\n",
    );
  });
});

const present: Block = {
  type: "table",
  key: "entries",
  items: [
    { repo: "api", present: true },
    { repo: "website", present: false },
  ],
};

describe("boolean table cells", () => {
  test("stay booleans in JSON", () => {
    const { out, written } = capture("json");
    out.report({ blocks: [present] });
    expect(JSON.parse(written.stdout).entries).toEqual([
      { repo: "api", present: true },
      { repo: "website", present: false },
    ]);
  });

  test("print true as ✓ and false as – in plain mode", () => {
    const { out, written } = capture("plain");
    out.report({ blocks: [present] });
    expect(written.stdout).toBe("api      ✓\nwebsite  –\n");
  });

  test("are padded like text and painted ok and muted in rich mode", () => {
    const { out, written } = capture("rich");
    out.report({
      blocks: [
        {
          type: "table",
          key: "t",
          items: [
            { present: true, repo: "api" },
            { present: false, repo: "web" },
          ],
        },
      ],
    });
    const ok = styleText("green", "✓", { validateStream: false });
    const muted = styleText("dim", "–", { validateStream: false });
    expect(written.stdout).toBe(`${ok}  api\n${muted}  web\n`);
  });
});

describe("boolean and number values", () => {
  const blocks: Block[] = [
    { type: "value", key: "removed", value: "api" },
    { type: "value", key: "folderDeleted", value: true },
    { type: "value", key: "count", value: 3 },
  ];

  test("stay a boolean and a number in JSON", () => {
    const { out, written } = capture("json");
    out.report({ blocks });
    expect(written.stdout).toBe(
      '{"ok":true,"warnings":[],"removed":"api","folderDeleted":true,"count":3}\n',
    );
  });

  test("print with their key in text modes, since the value alone says little", () => {
    const { out, written } = capture("plain");
    out.report({ blocks });
    expect(written.stdout).toBe("api\n\nfolderDeleted: true\n\ncount: 3\n");
  });
});

describe("error details", () => {
  test("plain details are error.details in JSON", () => {
    const { out, written } = capture("json");
    out.report({
      blocks: [],
      error: {
        code: "would-lose-work",
        message: "m",
        details: { uncommitted: ["a.txt"], stashes: 1 },
      },
    });
    expect(JSON.parse(written.stdout).error).toEqual({
      code: "would-lose-work",
      message: "m",
      details: { uncommitted: ["a.txt"], stashes: 1 },
    });
  });

  test("sit next to the data of the error blocks", () => {
    const { out, written } = capture("json");
    out.report({
      blocks: [],
      error: {
        code: "x",
        message: "m",
        details: { projects: ["feat"] },
        blocks: [{ type: "value", key: "failed", value: "api" }],
      },
    });
    expect(JSON.parse(written.stdout).error.details).toEqual({
      projects: ["feat"],
      failed: "api",
    });
  });

  test("a key in both the details and an error block throws", () => {
    const { out } = capture("json");
    expect(() =>
      out.report({
        blocks: [],
        error: {
          code: "x",
          message: "m",
          details: { failed: "web" },
          blocks: [{ type: "value", key: "failed", value: "api" }],
        },
      }),
    ).toThrow("failed");
  });

  test("empty details are left out", () => {
    const { out, written } = capture("json");
    out.report({ blocks: [], error: { code: "x", message: "m", details: {} } });
    expect(JSON.parse(written.stdout).error).toEqual({
      code: "x",
      message: "m",
    });
  });
});

const repos: Block = {
  type: "repos",
  items: [
    { repo: "api", status: "ok" },
    { repo: "web", status: "skipped", message: "already on disk" },
    {
      repo: "docs",
      status: "failed",
      message: "no remote in the config",
      hint: { code: "xr codebase clone" },
    },
  ],
};

describe("repos block", () => {
  test("JSON is a repos list; message and hint only when set", () => {
    const { out, written } = capture("json");
    out.report({ blocks: [repos] });
    expect(written.stdout).toBe(
      `${JSON.stringify({
        ok: true,
        warnings: [],
        repos: [
          { repo: "api", status: "ok" },
          { repo: "web", status: "skipped", message: "already on disk" },
          {
            repo: "docs",
            status: "failed",
            message: "no remote in the config",
            hint: "xr codebase clone",
          },
        ],
      })}\n`,
    );
  });

  test("an empty repos block is an empty list in JSON", () => {
    const { out, written } = capture("json");
    out.report({ blocks: [{ type: "repos", items: [] }] });
    expect(JSON.parse(written.stdout)).toEqual({
      ok: true,
      warnings: [],
      repos: [],
    });
  });

  test("text prints one line per repo like the live event, the hint under it", () => {
    const { out, written } = capture("plain");
    out.report({ blocks: [repos] });
    expect(written.stdout).toBe(
      [
        "✓ api",
        "– web: already on disk",
        "✗ docs: no remote in the config",
        "  xr codebase clone",
        "",
      ].join("\n"),
    );
  });

  test("rich text paints the symbols", () => {
    const { out, written } = capture("rich");
    out.report({ blocks: [repos] });
    expect(written.stdout).toContain(
      styleText("green", "✓", { validateStream: false }),
    );
  });

  test("an empty repos block prints nothing in text", () => {
    const { out, written } = capture("plain");
    out.report({ blocks: [{ type: "repos", items: [] }] });
    expect(written).toEqual({ stdout: "", stderr: "" });
  });

  test("on one screen, text leaves out repos already shown live; other blocks stay", () => {
    const { out, written } = capture("plain", "plain", CODEBASE, true);
    out.emit({ type: "repo", repo: "api", status: "ok" });
    out.report({
      blocks: [repos, { type: "note", tone: "muted", text: "done" }],
    });
    expect(written.stderr).toBe("✓ api\n");
    expect(written.stdout).toBe("done\n");
  });

  test("on one screen, a repos block with no live lines still prints", () => {
    const { out, written } = capture("plain", "plain", CODEBASE, true);
    out.report({ blocks: [repos] });
    expect(written.stdout).toStartWith("✓ api\n");
  });

  test("on two screens, text prints the repos again for stdout", () => {
    const { out, written } = capture("plain", "plain", CODEBASE, false);
    out.emit({ type: "repo", repo: "api", status: "ok" });
    out.report({ blocks: [repos] });
    expect(written.stdout).toStartWith("✓ api\n");
  });

  test("on a failure after live lines, text never prints the repos twice on stderr", () => {
    const { out, written } = capture("plain");
    out.emit({ type: "repo", repo: "api", status: "ok" });
    out.report({
      blocks: [repos],
      error: { code: "repos-failed", message: "1 repo failed." },
    });
    expect(written.stdout).toBe("");
    expect(written.stderr).toBe("✓ api\nerror: 1 repo failed.\n");
  });

  test("JSON keeps the repos after live lines", () => {
    const { out, written } = capture("json", "plain", CODEBASE, true);
    out.emit({ type: "repo", repo: "api", status: "ok" });
    out.report({ blocks: [repos] });
    expect(JSON.parse(written.stdout).repos).toHaveLength(3);
  });

  test("on a failure the repos sit next to error in JSON, and go to stderr in text", () => {
    const failure = {
      blocks: [repos],
      error: { code: "repos-failed", message: "1 repo failed." },
    };
    const json = capture("json");
    json.out.report(failure);
    const data = JSON.parse(json.written.stdout);
    expect(data.repos).toHaveLength(3);
    expect(data.error).toEqual({
      code: "repos-failed",
      message: "1 repo failed.",
    });
    const plain = capture("plain");
    plain.out.report(failure);
    expect(plain.written.stdout).toBe("");
    expect(plain.written.stderr).toEndWith(
      "  xr codebase clone\n\nerror: 1 repo failed.\n",
    );
  });
});

describe("section block", () => {
  const section: Block = {
    type: "section",
    key: "hookOutput",
    title: "Hook output",
    blocks: [
      { type: "value", key: "text", value: "line 1\nline 2" },
      { type: "value", key: "exitCode", value: 3 },
    ],
  };

  test("text: the title, then the inner blocks indented by 2", () => {
    const { out, written } = capture("plain");
    out.report({ blocks: [section] });
    expect(written.stdout).toBe(
      "Hook output\n  line 1\n  line 2\n\n  exitCode: 3\n",
    );
  });

  test("JSON: the key holds the data of the inner blocks", () => {
    const { out, written } = capture("json");
    out.report({ blocks: [section] });
    expect(JSON.parse(written.stdout).hookOutput).toEqual({
      text: "line 1\nline 2",
      exitCode: 3,
    });
  });

  test("as an error block, it is in error.details and printed after the error", () => {
    const json = capture("json");
    json.out.report({
      blocks: [],
      error: { code: "hook-failed", message: "m", blocks: [section] },
    });
    expect(JSON.parse(json.written.stdout).error.details).toEqual({
      hookOutput: { text: "line 1\nline 2", exitCode: 3 },
    });
    const text = capture("plain");
    text.out.report({
      blocks: [],
      error: { code: "hook-failed", message: "m", blocks: [section] },
    });
    expect(text.written.stderr).toContain("Hook output\n  line 1\n  line 2");
  });
});

describe("repos block source", () => {
  test("JSON keeps source when set; text does not show it", () => {
    const block: Block = {
      type: "repos",
      items: [
        { repo: "api", status: "ok", message: "local branch", source: "local" },
      ],
    };
    const json = capture("json");
    json.out.report({ blocks: [block] });
    expect(JSON.parse(json.written.stdout).repos).toEqual([
      { repo: "api", status: "ok", message: "local branch", source: "local" },
    ]);
    const text = capture("plain");
    text.out.report({ blocks: [block] });
    expect(text.written.stdout).toBe("✓ api: local branch\n");
  });
});

describe("projects block", () => {
  const P = join(CODEBASE, ".projects");
  const projects: Block = {
    type: "projects",
    items: [
      {
        project: "feat--login",
        branch: "feat/login",
        path: { path: join(P, "feat--login") },
        repos: ["api", "web"],
        created: "2026-10-20T14:03:12Z",
      },
      {
        project: "fix--bug",
        branch: "fix/bug",
        path: { path: join(P, "fix--bug") },
        repos: ["api"],
        created: "2026-10-18T09:00:00Z",
      },
    ],
  };

  test("text: one aligned row per project with the date, then its repos indented", () => {
    const { out, written } = capture("plain");
    out.report({ blocks: [projects] });
    expect(written.stdout).toBe(
      [
        "feat--login  feat/login  2026-10-20",
        "  api",
        "  web",
        "fix--bug     fix/bug     2026-10-18",
        "  api",
        "",
      ].join("\n"),
    );
  });

  test("text: no created gives an empty date and no trailing space", () => {
    const { out, written } = capture("plain");
    out.report({
      blocks: [
        {
          type: "projects",
          items: [
            {
              project: "old",
              branch: "old",
              path: { path: join(P, "old") },
              repos: ["api"],
            },
          ],
        },
      ],
    });
    expect(written.stdout).toBe("old  old\n  api\n");
  });

  test("text: an empty projects block prints nothing", () => {
    const { out, written } = capture("plain");
    out.report({ blocks: [{ type: "projects", items: [] }] });
    expect(written.stdout).toBe("");
  });

  test("JSON: entries with the absolute path, full created, and null for no created", () => {
    const { out, written } = capture("json");
    out.report({
      blocks: [projects, { type: "note", tone: "muted", text: "n" }],
    });
    expect(JSON.parse(written.stdout)).toEqual({
      ok: true,
      warnings: [],
      entries: [
        {
          project: "feat--login",
          branch: "feat/login",
          path: join(P, "feat--login"),
          repos: ["api", "web"],
          created: "2026-10-20T14:03:12Z",
        },
        {
          project: "fix--bug",
          branch: "fix/bug",
          path: join(P, "fix--bug"),
          repos: ["api"],
          created: "2026-10-18T09:00:00Z",
        },
      ],
      notes: ["n"],
    });
    const empty = capture("json");
    empty.out.report({
      blocks: [
        {
          type: "projects",
          items: [
            { project: "o", branch: "o", path: { path: "/o" }, repos: [] },
          ],
        },
      ],
    });
    expect(JSON.parse(empty.written.stdout).entries[0].created).toBeNull();
  });
});

describe("project block", () => {
  const dir = join(CODEBASE, ".projects", "feat--login");
  const project: Block = {
    type: "project",
    project: "feat--login",
    branch: "feat/login",
    path: { path: dir },
    codebase: { path: CODEBASE },
    created: "2026-10-20T14:03:12Z",
    repos: [
      { repo: "api", path: { path: join(dir, "api") }, present: true },
      { repo: "web", path: { path: join(dir, "web") }, present: true },
      { repo: "docs", path: { path: join(dir, "docs") }, present: false },
    ],
  };

  test("text: aligned label rows, the codebase in ~ form, then the repos with their state", () => {
    const { out, written } = capture("plain");
    out.report({ blocks: [project] });
    expect(written.stdout).toBe(
      [
        "project   feat--login",
        "branch    feat/login",
        `path      ${join(".projects", "feat--login")}`,
        `codebase  ${join("~", "code", "shop")}`,
        "created   2026-10-20T14:03:12Z",
        "repos",
        "  ✓ api",
        "  ✓ web",
        "  – docs   worktree folder missing",
        "",
      ].join("\n"),
    );
  });

  test("text: a codebase outside ~ is absolute; no created gives an empty row", () => {
    const outside = join(sep, "srv", "shop");
    const { out, written } = capture("plain", "plain", outside);
    out.report({
      blocks: [
        {
          type: "project",
          project: "x",
          branch: "x",
          path: { path: join(outside, ".projects", "x") },
          codebase: { path: outside },
          repos: [
            {
              repo: "api",
              path: { path: join(outside, ".projects", "x", "api") },
              present: true,
            },
          ],
        },
      ],
    });
    expect(written.stdout).toBe(
      [
        "project   x",
        "branch    x",
        `path      ${join(".projects", "x")}`,
        `codebase  ${outside}`,
        "created",
        "repos",
        "  ✓ api",
        "",
      ].join("\n"),
    );
  });

  test("rich text paints the repo states", () => {
    const { out, written } = capture("rich");
    out.report({ blocks: [project] });
    expect(written.stdout).toContain(ESC);
    expect(written.stdout).toContain("feat--login");
  });

  test("JSON: flat top-level keys with absolute paths", () => {
    const { out, written } = capture("json");
    out.report({ blocks: [project] });
    const data = JSON.parse(written.stdout);
    expect(Object.keys(data)).toEqual([
      "ok",
      "warnings",
      "project",
      "branch",
      "path",
      "codebase",
      "created",
      "repos",
    ]);
    expect(data).toEqual({
      ok: true,
      warnings: [],
      project: "feat--login",
      branch: "feat/login",
      path: dir,
      codebase: CODEBASE,
      created: "2026-10-20T14:03:12Z",
      repos: [
        { repo: "api", path: join(dir, "api"), present: true },
        { repo: "web", path: join(dir, "web"), present: true },
        { repo: "docs", path: join(dir, "docs"), present: false },
      ],
    });
  });

  test("JSON: no created is null, and a key clash with another block throws", () => {
    const { out, written } = capture("json");
    const { created: _, ...noCreated } = project as Extract<
      Block,
      { type: "project" }
    >;
    out.report({ blocks: [noCreated] });
    expect(JSON.parse(written.stdout).created).toBeNull();
    const clash = capture("json");
    expect(() =>
      clash.out.report({
        blocks: [project, { type: "value", key: "branch", value: "b" }],
      }),
    ).toThrow("branch");
  });
});

describe("repos block branchDeleted", () => {
  test("JSON keeps branchDeleted when set, also false; text does not show it", () => {
    const block: Block = {
      type: "repos",
      items: [
        {
          repo: "api",
          status: "ok",
          message: "worktree removed, branch deleted",
          branchDeleted: true,
        },
        {
          repo: "web",
          status: "ok",
          message: "worktree removed, branch kept",
          branchDeleted: false,
        },
        { repo: "docs", status: "ok" },
      ],
    };
    const json = capture("json");
    json.out.report({ blocks: [block] });
    expect(JSON.parse(json.written.stdout).repos).toEqual([
      {
        repo: "api",
        status: "ok",
        message: "worktree removed, branch deleted",
        branchDeleted: true,
      },
      {
        repo: "web",
        status: "ok",
        message: "worktree removed, branch kept",
        branchDeleted: false,
      },
      { repo: "docs", status: "ok" },
    ]);
    const text = capture("plain");
    text.out.report({ blocks: [block] });
    expect(text.written.stdout).toBe(
      [
        "✓ api: worktree removed, branch deleted",
        "✓ web: worktree removed, branch kept",
        "✓ docs",
        "",
      ].join("\n"),
    );
  });
});

describe("a note made of parts", () => {
  const note: Block = {
    type: "note",
    tone: "warn",
    text: ["Run `cd ", { path: CODEBASE, homeOnly: true }, "`."],
  };

  test("text joins the parts; a homeOnly path is relative to ~, never to the codebase", () => {
    const { out, written } = capture("plain");
    out.report({ blocks: [note] });
    expect(written.stdout).toBe(`Run \`cd ${join("~", "code", "shop")}\`.\n`);
  });

  test("JSON joins the parts with the absolute path", () => {
    const { out, written } = capture("json");
    out.report({ blocks: [note] });
    expect(JSON.parse(written.stdout).notes).toEqual([
      `Run \`cd ${CODEBASE}\`.`,
    ]);
  });
});

describe("project-repos block", () => {
  const dir = join(CODEBASE, ".projects", "feat--login");
  const block: Block = {
    type: "project-repos",
    project: "feat--login",
    entries: [
      {
        repo: "api",
        path: { path: join(dir, "api") },
        present: true,
        description: "Public REST API",
      },
      {
        repo: "web",
        path: { path: join(dir, "web") },
        present: true,
      },
      {
        repo: "docs",
        path: { path: join(dir, "docs") },
        present: false,
        description: "Docs site",
      },
    ],
  };

  test("text: mark, padded name, then the description or the missing folder", () => {
    const { out, written } = capture("plain");
    out.report({ blocks: [block] });
    expect(written.stdout).toBe(
      [
        "✓ api    Public REST API",
        "✓ web",
        "– docs   worktree folder missing",
        "",
      ].join("\n"),
    );
  });

  test("rich text paints the marks", () => {
    const { out, written } = capture("rich");
    out.report({ blocks: [block] });
    expect(written.stdout).toContain(ESC);
  });

  test("JSON: project and entries at the top level, absolute paths, null description", () => {
    const { out, written } = capture("json");
    out.report({ blocks: [block] });
    expect(written.stdout).toBe(
      `${JSON.stringify({
        ok: true,
        warnings: [],
        project: "feat--login",
        entries: [
          {
            repo: "api",
            path: join(dir, "api"),
            present: true,
            description: "Public REST API",
          },
          {
            repo: "web",
            path: join(dir, "web"),
            present: true,
            description: null,
          },
          {
            repo: "docs",
            path: join(dir, "docs"),
            present: false,
            description: "Docs site",
          },
        ],
      })}\n`,
    );
  });
});
