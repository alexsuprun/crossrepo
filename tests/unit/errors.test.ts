import { describe, expect, test } from "bun:test";
import {
  ERROR_CODES,
  EXIT_FAILURE,
  EXIT_INTERRUPTED,
  EXIT_OK,
  EXIT_USAGE,
  exitCodeFor,
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

  test("holds the config and discovery codes, each with exit 1", () => {
    for (const code of [
      "not-a-codebase",
      "unknown-config-key",
      "config-conflict",
      "invalid-config",
    ] as const) {
      expect(ERROR_CODES).toContain(code);
      expect(exitCodeFor(new XrError({ code, message: "x" }))).toBe(1);
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

  test("hint and details are optional", () => {
    const error = new XrError({ code: "internal", message: "crash" });
    expect(error.hint).toBeUndefined();
    expect(error.details).toBeUndefined();
  });
});

describe("exitCodeFor", () => {
  test("maps usage to 2", () => {
    expect(exitCodeFor(new XrError({ code: "usage", message: "x" }))).toBe(2);
  });

  test("maps any other code to 1", () => {
    expect(exitCodeFor(new XrError({ code: "internal", message: "x" }))).toBe(
      1,
    );
  });
});
