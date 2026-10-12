import { describe, expect, test } from "bun:test";
import {
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

function capture(stdoutMode: Mode, stderrMode: TextMode = "plain") {
  const written = { stdout: "", stderr: "" };
  const out = createOutput({
    modes: { stdout: stdoutMode, stderr: stderrMode },
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

describe("report in json mode", () => {
  test("is exactly one JSON object on stdout with ok and warnings", () => {
    const { out, written } = capture("json");
    out.report({ data: { version: "1.2.3" }, text: "1.2.3\n" });
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
    out.report({});
    expect(JSON.parse(written.stdout)).toEqual({
      ok: true,
      warnings: [
        { code: "a", message: "first", hint: "h" },
        { code: "b", message: "second" },
      ],
    });
    expect(written.stderr).toBe("! first\n  h\n! second\n");
  });

  test("a failure has ok false and the error with only the fields it has", () => {
    const { out, written } = capture("json");
    out.report({
      error: { code: "internal", message: "boom", hint: undefined },
    });
    expect(written.stdout).toBe(
      '{"ok":false,"warnings":[],"error":{"code":"internal","message":"boom"}}\n',
    );
    expect(written.stderr).toBe("");
  });

  test("a failure keeps hint, details and the command's own fields", () => {
    const { out, written } = capture("json");
    out.report({
      data: { repos: [{ repo: "api", status: "failed" }] },
      error: {
        code: "repos-failed",
        message: "1 repo failed",
        hint: "Run again.",
        details: { failed: 1 },
      },
    });
    expect(JSON.parse(written.stdout)).toEqual({
      ok: false,
      warnings: [],
      repos: [{ repo: "api", status: "failed" }],
      error: {
        code: "repos-failed",
        message: "1 repo failed",
        hint: "Run again.",
        details: { failed: 1 },
      },
    });
  });
});

describe("report in text mode", () => {
  test("prints the text on stdout and nothing on stderr", () => {
    const { out, written } = capture("plain");
    out.report({ data: { version: "1.2.3" }, text: "1.2.3\n" });
    expect(written).toEqual({ stdout: "1.2.3\n", stderr: "" });
  });

  test("prints no text on stdout when the report has an error", () => {
    const { out, written } = capture("plain");
    out.report({
      data: { version: "1.2.3" },
      text: "1.2.3\n",
      error: { code: "internal", message: "boom" },
    });
    expect(written).toEqual({ stdout: "", stderr: "error: boom\n" });
  });

  test("prints an error with its hint on stderr only", () => {
    const { out, written } = capture("plain");
    out.report({
      error: { code: "usage", message: "bad flag", hint: "Run it right." },
    });
    expect(written).toEqual({
      stdout: "",
      stderr: "error: bad flag\nRun it right.\n",
    });
  });

  test("prints an error without a hint as one line", () => {
    const { out, written } = capture("rich", "plain");
    out.report({ error: { code: "internal", message: "boom" } });
    expect(written).toEqual({ stdout: "", stderr: "error: boom\n" });
  });

  test("styles the error on a rich stderr", () => {
    const { out, written } = capture("plain", "rich");
    out.report({ error: { code: "usage", message: "bad", hint: "h" } });
    expect(written.stderr).toContain(ESC);
    expect(written.stderr).toContain("bad");
  });
});
