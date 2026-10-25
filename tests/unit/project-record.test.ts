import { describe, expect, test } from "bun:test";
import {
  parseProjectRecord as parseRecord,
  renderProjectRecord,
} from "../../src/domain/project-record.ts";

/** The reader as `codebase repo remove` uses it: a record with no `branch` is still read. */
const parseProjectRecord = (text: string) =>
  parseRecord(text, { requireBranch: false });

describe("parseProjectRecord", () => {
  test("reads branch, codebase, repos as a list, and created", () => {
    expect(
      parseRecord(
        "branch: feat/x\ncodebase: ../..\nrepos: [api, web]\ncreated: 2026-10-20T14:03:12Z\n",
      ),
    ).toEqual({
      branch: "feat/x",
      codebase: "../..",
      repos: ["api", "web"],
      created: "2026-10-20T14:03:12Z",
    });
  });

  test("no branch gives a problem by default", () => {
    expect(parseRecord("codebase: /c\nrepos: [api]\n")).toEqual({
      problem: "it has no `branch`",
    });
    expect(parseRecord("branch: ''\ncodebase: /c\nrepos: [api]\n")).toEqual({
      problem: "it has no `branch`",
    });
  });

  test("with requireBranch false, a record with no branch is read", () => {
    expect(parseProjectRecord("codebase: /c\nrepos: [api]\n")).toEqual({
      codebase: "/c",
      repos: ["api"],
    });
  });

  test("reads codebase and repos as a list", () => {
    expect(
      parseProjectRecord("codebase: ../..\nrepos: [api, web]\nbranch: x\n"),
    ).toEqual({ branch: "x", codebase: "../..", repos: ["api", "web"] });
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

describe("renderProjectRecord", () => {
  test("writes the keys in order, repos as a list", () => {
    expect(
      renderProjectRecord({
        branch: "feat/x",
        codebase: "/work/shop",
        repos: ["api", "web"],
        created: "2026-10-20T14:03:12Z",
      }),
    ).toBe(
      "branch: feat/x\ncodebase: /work/shop\nrepos:\n  - api\n  - web\ncreated: 2026-10-20T14:03:12Z\n",
    );
  });

  test("quotes values that YAML would read as something else, and reads back the same", () => {
    const record = {
      branch: "123",
      codebase: "C:\\Users\\me\\shop #1",
      repos: ["1.0", "true", "a: b"],
      created: "2026-10-20T14:03:12Z",
    };
    const text = renderProjectRecord(record);
    expect(text).toContain('branch: "123"');
    expect(parseRecord(text)).toEqual(record);
  });
});
