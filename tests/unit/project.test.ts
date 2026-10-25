import { describe, expect, test } from "bun:test";
import {
  badBranchChars,
  branchSlug,
  hookEnv,
  hookStepLabel,
  hookVars,
  isoSeconds,
  lastLines,
} from "../../src/domain/project.ts";

describe("branchSlug", () => {
  test("replaces each / with --", () => {
    expect(branchSlug("feat/login")).toBe("feat--login");
    expect(branchSlug("a/b/c")).toBe("a--b--c");
    expect(branchSlug("main")).toBe("main");
  });
});

describe("badBranchChars", () => {
  test('gives each of <>:|"?* found, once, in branch order', () => {
    expect(badBranchChars("feat/x")).toEqual([]);
    expect(badBranchChars('a<b>c:d|e"f?g*h')).toEqual([
      "<",
      ">",
      ":",
      "|",
      '"',
      "?",
      "*",
    ]);
    expect(badBranchChars("a??b")).toEqual(["?"]);
  });
});

describe("hookEnv", () => {
  const builtIns = { CROSSREPO_HOOK: "post-create" };

  test("inherited env, then vars, then the built-ins; a later name wins", () => {
    expect(
      hookEnv(
        { PATH: "/bin", PORT: "1", CROSSREPO_HOOK: "old", GONE: undefined },
        { PORT: "2", CROSSREPO_HOOK: "user" },
        builtIns,
        "linux",
      ),
    ).toEqual({ PATH: "/bin", PORT: "2", CROSSREPO_HOOK: "post-create" });
  });

  test("on POSIX, names that differ in case are two names", () => {
    expect(hookEnv({ Path: "a" }, { PATH: "b" }, {}, "darwin")).toEqual({
      Path: "a",
      PATH: "b",
    });
  });

  test("on Windows, names match with case ignored, and the later spelling stays", () => {
    expect(
      hookEnv(
        { Path: "a", crossrepo_hook: "x" },
        { PATH: "b" },
        builtIns,
        "win32",
      ),
    ).toEqual({ PATH: "b", CROSSREPO_HOOK: "post-create" });
  });
});

describe("hookVars", () => {
  test("gives the 7 built-in vars, repos one per line in order", () => {
    expect(
      hookVars({
        codebasePath: "/c",
        codebaseName: "shop",
        projectPath: "/c/.projects/feat--x",
        projectName: "feat--x",
        branch: "feat/x",
        repos: ["api", "web"],
        hook: "post-create",
      }),
    ).toEqual({
      CROSSREPO_CODEBASE_PATH: "/c",
      CROSSREPO_CODEBASE_NAME: "shop",
      CROSSREPO_PROJECT_PATH: "/c/.projects/feat--x",
      CROSSREPO_PROJECT_NAME: "feat--x",
      CROSSREPO_PROJECT_BRANCH: "feat/x",
      CROSSREPO_PROJECT_REPOS: "api\nweb",
      CROSSREPO_HOOK: "post-create",
    });
  });
});

describe("hookStepLabel", () => {
  test("is post-create: <command> when it is short", () => {
    expect(hookStepLabel("post-create", "make setup")).toBe(
      "post-create: make setup",
    );
  });

  test("keeps only the first line, marked as cut", () => {
    expect(hookStepLabel("post-create", "echo a\necho b")).toBe(
      "post-create: echo a…",
    );
  });

  test("is cut to 60 characters", () => {
    const label = hookStepLabel("post-create", "x".repeat(100));
    expect(label.length).toBe(60);
    expect(label.endsWith("…")).toBe(true);
    expect(label.startsWith("post-create: xxx")).toBe(true);
  });

  test("a label of exactly 60 characters is not cut", () => {
    const command = "y".repeat(60 - "post-create: ".length);
    expect(hookStepLabel("post-create", command)).toBe(
      `post-create: ${command}`,
    );
  });
});

describe("lastLines", () => {
  test("gives the last n lines without the final newline", () => {
    const text = `${Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
    const last = lastLines(text, 20).split("\n");
    expect(last).toHaveLength(20);
    expect(last[0]).toBe("line 6");
    expect(last[19]).toBe("line 25");
  });

  test("reads CRLF and keeps short text whole", () => {
    expect(lastLines("a\r\nb\r\n", 20)).toBe("a\nb");
    expect(lastLines("", 20)).toBe("");
  });
});

describe("isoSeconds", () => {
  test("is ISO 8601 UTC to the second with Z", () => {
    expect(isoSeconds(new Date("2026-10-20T14:03:12.987Z"))).toBe(
      "2026-10-20T14:03:12Z",
    );
  });
});
