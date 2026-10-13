import { describe, expect, test } from "bun:test";
import { join, sep } from "node:path";
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
) {
  const written = { stdout: "", stderr: "" };
  const out = createOutput({
    modes: { stdout: stdoutMode, stderr: stderrMode },
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
    const blocks: Block[] = [
      { type: "repos", items: [] },
      { type: "checks", items: [] },
      { type: "section", key: "s", title: "S", blocks: [] },
    ];
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
