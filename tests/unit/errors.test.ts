import { describe, expect, test } from "bun:test";
import {
  ERROR_CODES,
  EXIT_FAILURE,
  EXIT_INTERRUPTED,
  EXIT_OK,
  EXIT_USAGE,
  exitCodeFor,
  GitError,
  interrupted,
  withBlocks,
  XrError,
} from "../../src/errors/index.ts";

describe("exit codes", () => {
  test("have the fixed values", () => {
    expect([EXIT_OK, EXIT_FAILURE, EXIT_USAGE, EXIT_INTERRUPTED]).toEqual([
      0, 1, 2, 130,
    ]);
  });
});

describe("ERROR_CODES", () => {
  test("holds usage and internal", () => {
    expect(ERROR_CODES).toContain("usage");
    expect(ERROR_CODES).toContain("internal");
  });

  test("holds the config, discovery and file codes, each with exit 1", () => {
    for (const code of [
      "not-a-codebase",
      "unknown-config-key",
      "config-conflict",
      "invalid-config",
      "file-busy",
      "git-too-old",
      "git-failed",
      "repos-not-ready",
      "already-a-codebase",
      "inside-a-project",
      "lock-held",
      "not-in-codebase",
      "repo-exists",
      "repo-not-found",
      "repo-in-use",
      "invalid-project-record",
      "would-lose-work",
      "repos-failed",
      "project-exists",
      "branch-in-use",
      "no-default-branch",
      "hook-failed",
      "sh-not-found",
      "project-not-found",
    ] as const) {
      expect(ERROR_CODES).toContain(code);
      expect(exitCodeFor(new XrError({ code, message: "x" }))).toBe(1);
    }
  });

  test("holds the lock and Ctrl-C codes", () => {
    for (const code of ["lock-held", "interrupted", "stale-lock"] as const) {
      expect(ERROR_CODES).toContain(code);
    }
  });

  test("every code is kebab-case and declared once", () => {
    for (const code of ERROR_CODES) {
      expect(code).toMatch(/^[a-z]+(-[a-z]+)*$/);
    }
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });
});

describe("XrError", () => {
  test("carries code, message, hint and details", () => {
    const error = new XrError({
      code: "usage",
      message: "bad flag",
      hint: "Run xr --help.",
      details: { flag: "--nope" },
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("XrError");
    expect(error.code).toBe("usage");
    expect(error.message).toBe("bad flag");
    expect(error.hint).toBe("Run xr --help.");
    expect(error.details).toEqual({ flag: "--nope" });
  });

  test("hint, details and blocks are optional", () => {
    const error = new XrError({ code: "internal", message: "crash" });
    expect(error.hint).toBeUndefined();
    expect(error.details).toBeUndefined();
    expect(error.blocks).toBeUndefined();
  });

  test("carries Report blocks for error.details", () => {
    const blocks = [{ type: "value", key: "k", value: "v" }];
    const error = new XrError({ code: "usage", message: "x", blocks });
    expect(error.blocks).toEqual(blocks);
  });

  test("carries top-level Report blocks, which sit next to error in JSON", () => {
    const report = [{ type: "repos", items: [] }];
    const error = new XrError({ code: "repos-failed", message: "x", report });
    expect(error.report).toEqual(report);
    expect(new XrError({ code: "usage", message: "x" }).report).toBeUndefined();
  });
});

describe("GitError", () => {
  test("is an XrError with code git-failed, the args, the exit code and stderr", () => {
    const error = new GitError({
      args: ["-C", "/x", "status"],
      exitCode: 128,
      stderr: "fatal: not a git repository\n",
    });
    expect(error).toBeInstanceOf(XrError);
    expect(error.name).toBe("GitError");
    expect(error.code).toBe("git-failed");
    expect(error.args).toEqual(["-C", "/x", "status"]);
    expect(error.exitCode).toBe(128);
    expect(error.stderr).toBe("fatal: not a git repository\n");
    expect(error.message).toBe(
      "`git -C /x status` failed: fatal: not a git repository",
    );
  });

  test("with no stderr the message names the exit code", () => {
    const error = new GitError({ args: ["version"], exitCode: 1, stderr: "" });
    expect(error.message).toBe("`git version` failed with exit code 1.");
  });
});

describe("withBlocks", () => {
  const leftovers = { type: "leftovers", items: [] };

  test("adds blocks to an XrError and keeps its class and its own blocks", () => {
    const first = { type: "value", key: "k", value: "v" };
    const error = new GitError({ args: ["x"], exitCode: 1, stderr: "" });
    Object.assign(error, { blocks: [first] });
    const result = withBlocks(error, [leftovers]);
    expect(result).toBe(error);
    expect(result.blocks).toEqual([first, leftovers]);
  });

  test("wraps any other error as internal with the cause and its stack", () => {
    const cause = new Error("EACCES: mkdir");
    const result = withBlocks(cause, [leftovers]);
    expect(result).toBeInstanceOf(XrError);
    expect(result.code).toBe("internal");
    expect(result.message).toBe("EACCES: mkdir");
    expect(result.cause).toBe(cause);
    expect(result.stack).toBe(cause.stack as string);
    expect(result.blocks).toEqual([leftovers]);
  });

  test("wraps a thrown non-error as internal", () => {
    expect(withBlocks("boom", []).message).toBe("boom");
  });
});

describe("interrupted", () => {
  test("is the interrupted error of a run stopped by Ctrl-C", () => {
    const error = interrupted();
    expect(error).toBeInstanceOf(XrError);
    expect(error.code).toBe("interrupted");
    expect(error.message).toBe("Stopped by Ctrl-C.");
  });
});

describe("exitCodeFor", () => {
  test("maps usage to 2", () => {
    expect(exitCodeFor(new XrError({ code: "usage", message: "x" }))).toBe(2);
  });

  test("maps missing-argument to 2", () => {
    expect(ERROR_CODES).toContain("missing-argument");
    expect(
      exitCodeFor(new XrError({ code: "missing-argument", message: "x" })),
    ).toBe(EXIT_USAGE);
  });

  test("maps interrupted to 130", () => {
    expect(
      exitCodeFor(new XrError({ code: "interrupted", message: "x" })),
    ).toBe(EXIT_INTERRUPTED);
  });

  test("maps any other code to 1", () => {
    expect(exitCodeFor(new XrError({ code: "internal", message: "x" }))).toBe(
      1,
    );
  });
});
