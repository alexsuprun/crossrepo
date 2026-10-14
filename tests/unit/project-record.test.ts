import { describe, expect, test } from "bun:test";
import { parseProjectRecord } from "../../src/domain/project-record.ts";

describe("parseProjectRecord", () => {
  test("reads codebase and repos as a list", () => {
    expect(
      parseProjectRecord("codebase: ../..\nrepos: [api, web]\nbranch: x\n"),
    ).toEqual({ codebase: "../..", repos: ["api", "web"] });
  });

  test("reads repos as a map: its keys are the names, as written", () => {
    expect(
      parseProjectRecord(
        "codebase: /c\nrepos:\n  api: {}\n  1.0:\n    path: x\n",
      ),
    ).toEqual({ codebase: "/c", repos: ["api", "1.0"] });
  });

  test("a list item that YAML reads as a number keeps its text", () => {
    expect(parseProjectRecord("codebase: /c\nrepos: [1.0, '2']\n")).toEqual({
      codebase: "/c",
      repos: ["1.0", "2"],
    });
  });

  test("an empty list or map is no repos", () => {
    expect(parseProjectRecord("codebase: /c\nrepos: []\n")).toEqual({
      codebase: "/c",
      repos: [],
    });
    expect(parseProjectRecord("codebase: /c\nrepos: {}\n")).toEqual({
      codebase: "/c",
      repos: [],
    });
  });

  for (const [what, text] of [
    ["bad YAML", "codebase: [\n"],
    ["a list at the top", "- a\n"],
    ["a text at the top", "hello\n"],
    ["an empty file", ""],
    ["no codebase", "repos: [api]\n"],
    ["a codebase that is not a text", "codebase: 1\nrepos: [api]\n"],
    ["an empty codebase", "codebase: ''\nrepos: [api]\n"],
    ["no repos", "codebase: /c\n"],
    ["null repos", "codebase: /c\nrepos:\n"],
    ["repos as a text", "codebase: /c\nrepos: api\n"],
    ["a repo that is not a text", "codebase: /c\nrepos: [api, {a: 1}]\n"],
    ["a null repo", "codebase: /c\nrepos: [api, ~]\n"],
  ] as const) {
    test(`${what} gives a problem`, () => {
      const result = parseProjectRecord(text);
      expect(result).toHaveProperty("problem");
      expect((result as { problem: string }).problem).not.toBe("");
    });
  }
});
