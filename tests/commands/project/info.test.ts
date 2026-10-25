import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Isolation, isolate, writeFile } from "../../helpers/isolate.ts";
import {
  forbidGit,
  makeCodebase,
  makeProject,
  runXr,
} from "../../helpers/projects.ts";

let iso: Isolation;
let codebase: string;
let projects: string;
let login: string;
let gitSpy: { mockRestore(): void };

const INFO = ["project", "info"];

beforeEach(() => {
  iso = isolate();
  // Under the home folder, so the text shows `codebase  ~/work/acme`.
  codebase = join(iso.home, "work", "acme");
  projects = join(codebase, ".projects");
  makeCodebase(codebase);
  login = makeProject(
    projects,
    "feat--login",
    "feat/login",
    ["api", "web", "docs"],
    { codebase },
  );
  makeProject(projects, "fix--bug", "fix/bug", ["api"], { codebase });
  gitSpy = forbidGit();
});

afterEach(() => {
  gitSpy.mockRestore();
  iso.restore();
});

const run = (argv: string[], cwd = codebase, tty = false) =>
  runXr({ argv, cwd, home: iso.home, tty });

async function json(argv: string[], cwd = codebase) {
  const result = await run(["--json", ...argv], cwd);
  return { ...result, data: JSON.parse(result.stdout) };
}

const LOGIN_TEXT = [
  "project   feat--login",
  "branch    feat/login",
  `path      ${join(".projects", "feat--login")}`,
  `codebase  ${join("~", "work", "acme")}`,
  "created   2026-10-20T14:03:12Z",
  "repos",
  "  ✓ api",
  "  ✓ web",
  "  ✓ docs",
  "",
].join("\n");

describe("xr project info in a project folder", () => {
  test("with no argument shows that project", async () => {
    const result = await run(INFO, login);
    expect(result).toEqual({ code: 0, stdout: LOGIN_TEXT, stderr: "" });
  });

  test("with --json gives flat keys with absolute paths", async () => {
    const result = await json(INFO, login);
    expect(result.code).toBe(0);
    expect(Object.keys(result.data)).toEqual([
      "ok",
      "warnings",
      "project",
      "branch",
      "path",
      "codebase",
      "created",
      "repos",
    ]);
    expect(result.data).toEqual({
      ok: true,
      warnings: [],
      project: "feat--login",
      branch: "feat/login",
      path: login,
      codebase,
      created: "2026-10-20T14:03:12Z",
      repos: [
        { repo: "api", path: join(login, "api"), present: true },
        { repo: "web", path: join(login, "web"), present: true },
        { repo: "docs", path: join(login, "docs"), present: true },
      ],
    });
  });

  test("with an argument shows the named project", async () => {
    const result = await json([...INFO, "fix--bug"], login);
    expect(result.data.project).toBe("fix--bug");
  });
});

describe("xr project info <project> in a codebase folder", () => {
  test("by folder name", async () => {
    const result = await run([...INFO, "feat--login"]);
    expect(result).toEqual({ code: 0, stdout: LOGIN_TEXT, stderr: "" });
  });

  test("by branch", async () => {
    const result = await run([...INFO, "feat/login"]);
    expect(result).toEqual({ code: 0, stdout: LOGIN_TEXT, stderr: "" });
  });

  test("an unknown name is project-not-found, exit 1, with the list hint", async () => {
    const result = await json([...INFO, "nope"]);
    expect(result.code).toBe(1);
    expect(result.data.error).toMatchObject({
      code: "project-not-found",
      hint: "Run `xr project list` to see the projects.",
      details: { project: "nope" },
    });
    const text = await run([...INFO, "nope"]);
    expect(text.stdout).toBe("");
    expect(text.stderr).toContain("xr project list");
  });

  test("a project of another codebase is not found", async () => {
    const other = join(iso.root, "other");
    makeCodebase(other);
    makeProject(projects, "theirs", "theirs", ["api"], { codebase: other });
    const result = await json([...INFO, "theirs"]);
    expect(result.data.error.code).toBe("project-not-found");
  });

  test("a broken record is a warning; the named project still shows", async () => {
    const bad = writeFile(
      join(projects, "bad", ".crossrepo", "project.yaml"),
      "branch: [\n",
    );
    const result = await json([...INFO, "fix--bug"]);
    expect(result.code).toBe(0);
    expect(result.data.project).toBe("fix--bug");
    expect(result.data.warnings[0].code).toBe("invalid-project-record");
    expect(result.data.warnings[0].message).toContain(bad);
  });
});

describe("xr project info with no argument in a codebase folder", () => {
  test("is missing-argument, exit 2, with the project names", async () => {
    const result = await json(INFO);
    expect(result.code).toBe(2);
    expect(result.data.error).toMatchObject({
      code: "missing-argument",
      details: { argument: "project", choices: ["feat--login", "fix--bug"] },
    });
  });

  test("opens no picker, also in a terminal", async () => {
    const result = await run(INFO, codebase, true);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("feat--login, fix--bug");
  });

  test("with no projects, choices is empty and the hint says how to start one", async () => {
    rmSync(projects, { recursive: true });
    const result = await json(INFO);
    expect(result.code).toBe(2);
    expect(result.data.error.details).toEqual({
      argument: "project",
      choices: [],
    });
    expect(result.data.error.hint).toContain("xr project create");
  });
});

test("a missing worktree folder shows – and present false", async () => {
  rmSync(join(login, "docs"), { recursive: true });
  const text = await run(INFO, login);
  expect(text.code).toBe(0);
  expect(text.stdout).toContain(
    "  ✓ web\n  – docs   worktree folder missing\n",
  );
  const result = await json(INFO, login);
  expect(result.data.repos[2]).toEqual({
    repo: "docs",
    path: join(login, "docs"),
    present: false,
  });
});

test("a file in place of a worktree folder is not present", async () => {
  rmSync(join(login, "docs"), { recursive: true });
  writeFile(join(login, "docs"), "x");
  const result = await json(INFO, login);
  expect(result.data.repos[2].present).toBe(false);
});

test("a codebase outside the home folder shows as an absolute path", async () => {
  const outside = join(iso.root, "shop");
  makeCodebase(outside);
  const dir = makeProject(join(outside, ".projects"), "x", "x", ["api"], {
    codebase: outside,
  });
  const result = await run(INFO, dir);
  expect(result.stdout).toContain(`codebase  ${outside}\n`);
});

test("in a folder that is not a codebase or project it fails with not-a-codebase", async () => {
  const elsewhere = join(iso.root, "elsewhere");
  mkdirSync(elsewhere);
  const result = await json([...INFO, "feat--login"], elsewhere);
  expect(result.code).toBe(1);
  expect(result.data.error.code).toBe("not-a-codebase");
});

test("takes no lock and makes no git call", async () => {
  // A lock held by a running process: a command that takes the lock fails.
  const lockFile = writeFile(
    join(codebase, ".crossrepo", "xr.lock"),
    `${process.ppid}\n`,
  );
  expect((await run(INFO, login)).code).toBe(0);
  expect((await run([...INFO, "fix/bug"])).code).toBe(0);
  expect(readFileSync(lockFile, "utf8")).toBe(`${process.ppid}\n`);
});

test("two arguments are a usage error", async () => {
  expect((await run([...INFO, "a", "b"])).code).toBe(2);
});

test("in a project folder whose record has no branch, no argument is invalid-project-record", async () => {
  writeFile(
    join(login, ".crossrepo", "project.yaml"),
    `codebase: ${codebase}\nrepos:\n  - api\n`,
  );
  const result = await json(INFO, login);
  expect(result.code).toBe(1);
  expect(result.data.error.code).toBe("invalid-project-record");
  expect(result.data.error.message).toContain(
    join(login, ".crossrepo", "project.yaml"),
  );
});
