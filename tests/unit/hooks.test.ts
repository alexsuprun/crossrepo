import { describe, expect, test } from "bun:test";
import { interrupted, XrError } from "../../src/errors/index.ts";
import { hookFailed, hookWarning } from "../../src/services/hooks.ts";

describe("hookFailed", () => {
  test("names the pre-remove hook in the message and the hint", () => {
    const error = hookFailed("pre-remove", "make stop", {
      ok: false,
      exitCode: 3,
      timedOut: false,
      output: "a\nb\n",
    });
    expect(error.code).toBe("hook-failed");
    expect(error.message).toBe(
      "The pre-remove hook `make stop` failed with exit code 3.",
    );
    expect(error.hint).toBe(
      "Fix the line in `project.pre-remove` of the config, then run the command again.",
    );
    expect(error.details).toEqual({
      command: "make stop",
      exitCode: 3,
      timedOut: false,
    });
    expect(error.blocks).toEqual([
      {
        type: "section",
        key: "hookOutput",
        title: "Hook output",
        blocks: [{ type: "value", key: "lines", value: "a\nb" }],
      },
    ]);
  });

  test("keeps the post-create texts", () => {
    const error = hookFailed("post-create", "x", {
      ok: false,
      exitCode: null,
      timedOut: true,
      output: "",
    });
    expect(error.message).toBe(
      "The post-create hook `x` timed out after 10 minutes.",
    );
    expect(error.hint).toBe(
      "Fix the line in `project.post-create` of the config, then run the command again.",
    );
  });

  test("a line stopped by a signal says so", () => {
    const error = hookFailed("pre-remove", "x", {
      ok: false,
      exitCode: null,
      timedOut: false,
      output: "",
    });
    expect(error.message).toBe(
      "The pre-remove hook `x` was stopped by a signal.",
    );
  });

  test("names the pre-create and post-remove hooks", () => {
    const result = {
      ok: false,
      exitCode: 1,
      timedOut: false,
      output: "",
    } as const;
    expect(hookFailed("pre-create", "check", result).message).toBe(
      "The pre-create hook `check` failed with exit code 1.",
    );
    const error = hookFailed("post-remove", "close", result);
    expect(error.message).toBe(
      "The post-remove hook `close` failed with exit code 1.",
    );
    expect(error.hint).toBe(
      "Fix the line in `project.post-remove` of the config, then run the command again.",
    );
  });
});

describe("hookWarning", () => {
  const failed = hookFailed("post-remove", "a", {
    ok: false,
    exitCode: 2,
    timedOut: false,
    output: "x\ny\n",
  });
  const stopped = hookFailed("post-remove", "a", {
    ok: false,
    exitCode: null,
    timedOut: false,
    output: "x\n",
  });
  const CTRL_C_HINT =
    "The project is removed. Run by hand the lines that did not run, if they are needed: `a`, `b`.";

  test("a failed line: its message, a hint that names it and the lines after it, and the output lines", () => {
    expect(hookWarning("post-remove", failed, ["a", "b"])).toEqual({
      code: "hook-failed",
      message: "The post-remove hook `a` failed with exit code 2.",
      hint: "The project is removed. Fix the line in `project.post-remove`, then run by hand the lines that did not run: `a`, `b`.",
      lines: ["x", "y"],
    });
  });

  test("a failed line that printed nothing: no lines", () => {
    const silent = hookFailed("post-remove", "a", {
      ok: false,
      exitCode: 1,
      timedOut: false,
      output: "",
    });
    expect(hookWarning("post-remove", silent, ["a"])).toEqual({
      code: "hook-failed",
      message: "The post-remove hook `a` failed with exit code 1.",
      hint: "The project is removed. Fix the line in `project.post-remove`, then run by hand the lines that did not run: `a`.",
    });
  });

  test("a Ctrl-C that stopped a line: names it, the Ctrl-C hint and the output lines", () => {
    expect(
      hookWarning("post-remove", interrupted(stopped), ["a", "b"]),
    ).toEqual({
      code: "hook-failed",
      message: "The post-remove hook `a` was stopped by Ctrl-C.",
      hint: CTRL_C_HINT,
      lines: ["x"],
    });
  });

  test("a Ctrl-C before a line: names the lines that did not run", () => {
    expect(hookWarning("post-remove", interrupted(), ["a", "b"])).toEqual({
      code: "hook-failed",
      message:
        "The post-remove hook was stopped by Ctrl-C before `a`, `b` ran.",
      hint: CTRL_C_HINT,
    });
  });

  test("a Ctrl-C during a line that failed in another way: names that line", () => {
    expect(
      hookWarning("post-remove", interrupted(new Error("spawn")), ["a", "b"]),
    ).toEqual({
      code: "hook-failed",
      message: "The post-remove hook `a` was stopped by Ctrl-C.",
      hint: CTRL_C_HINT,
    });
  });

  test("any other error gives no warning", () => {
    expect(hookWarning("post-remove", new Error("x"), ["a"])).toBeUndefined();
    expect(
      hookWarning(
        "post-remove",
        new XrError({ code: "internal", message: "x" }),
        ["a"],
      ),
    ).toBeUndefined();
  });
});
