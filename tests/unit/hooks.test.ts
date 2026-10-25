import { describe, expect, test } from "bun:test";
import { hookFailed } from "../../src/services/hooks.ts";

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
});
