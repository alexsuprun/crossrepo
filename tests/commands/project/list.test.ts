import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as gitAdapter from "../../../src/adapters/git/index.ts";
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
let gitSpy: { mockRestore(): void };

const LIST = ["project", "list"];
const EMPTY_NOTE =
  "No projects. Start one with `xr project create <branch> <repo>...`";

beforeEach(() => {
  iso = isolate();
  codebase = join(iso.root, "shop");
  projects = join(codebase, ".projects");
  makeCodebase(codebase);
  gitSpy = forbidGit();
});

afterEach(() => {
  gitSpy.mockRestore();
  iso.restore();
});

const run = (argv: string[], cwd = codebase) =>
  runXr({ argv, cwd, home: iso.home });

async function json(argv: string[], cwd = codebase) {
  const result = await run(["--json", ...argv], cwd);
  return { ...result, data: JSON.parse(result.stdout) };
}

function twoProjects() {
  makeProject(projects, "fix--bug", "fix/bug", ["api"], {
    codebase,
    created: "2026-10-18T09:30:00Z",
  });
  makeProject(projects, "feat--login", "feat/login", ["api", "web"], {
    codebase,
  });
}

describe("xr project list with no projects", () => {
  test("a missing projects-dir prints only the note and exits 0", async () => {
    const result = await run(LIST);
    expect(result).toEqual({ code: 0, stdout: `${EMPTY_NOTE}\n`, stderr: "" });
  });

  test("an empty projects-dir gives empty entries and the note in JSON", async () => {
    mkdirSync(projects);
    const result = await json(LIST);
    expect(result.code).toBe(0);
    expect(result.data).toEqual({
      ok: true,
      warnings: [],
      entries: [],
      notes: [EMPTY_NOTE],
    });
  });
});

describe("xr project list with several projects", () => {
  test("text: name order, aligned columns, repos as child lines in record order", async () => {
    twoProjects();
    const result = await run(LIST);
    expect(result).toEqual({
      code: 0,
      stdout: [
        "feat--login  feat/login  2026-10-20",
        "  api",
        "  web",
        "fix--bug     fix/bug     2026-10-18",
        "  api",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  test("JSON: exactly ok, warnings and entries, with absolute paths and the full created", async () => {
    twoProjects();
    const result = await json(LIST);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(Object.keys(result.data)).toEqual(["ok", "warnings", "entries"]);
    expect(result.data.entries).toEqual([
      {
        project: "feat--login",
        branch: "feat/login",
        path: join(projects, "feat--login"),
        repos: ["api", "web"],
        created: "2026-10-20T14:03:12Z",
      },
      {
        project: "fix--bug",
        branch: "fix/bug",
        path: join(projects, "fix--bug"),
        repos: ["api"],
        created: "2026-10-18T09:30:00Z",
      },
    ]);
  });

  test("in a project folder it lists the projects of its codebase", async () => {
    twoProjects();
    const inProject = await run(LIST, join(projects, "fix--bug"));
    expect(inProject).toEqual(await run(LIST));
  });

  test("a record with no created gives null in JSON", async () => {
    makeProject(projects, "old", "old", ["api"], { codebase, created: null });
    const result = await json(LIST);
    expect(result.data.entries[0].created).toBeNull();
    expect((await run(LIST)).stdout).toBe("old  old\n  api\n");
  });
});

test("a project of another codebase in the same projects-dir is not listed", async () => {
  const other = join(iso.root, "other");
  makeCodebase(other);
  makeProject(projects, "theirs", "theirs", ["api"], { codebase: other });
  makeProject(projects, "mine", "mine", ["api"], { codebase });
  const result = await json(LIST);
  expect(
    result.data.entries.map(({ project }: { project: string }) => project),
  ).toEqual(["mine"]);
});

describe("a broken record", () => {
  test("is a warning with its path, and the other projects are listed", async () => {
    const bad = writeFile(
      join(projects, "bad", ".crossrepo", "project.yaml"),
      "branch: [\n",
    );
    const noBranch = writeFile(
      join(projects, "nobranch", ".crossrepo", "project.yaml"),
      `codebase: ${codebase}\nrepos:\n  - api\n`,
    );
    twoProjects();
    const result = await json(LIST);
    expect(result.code).toBe(0);
    expect(result.data.entries).toHaveLength(2);
    expect(result.data.warnings).toHaveLength(2);
    expect(result.data.warnings[0]).toMatchObject({
      code: "invalid-project-record",
    });
    expect(result.data.warnings[0].message).toContain(bad);
    expect(result.data.warnings[0].hint).toBeString();
    expect(result.data.warnings[1].message).toContain(noBranch);
    const text = await run(LIST);
    expect(text.code).toBe(0);
    expect(text.stderr).toContain(`! The project record ${bad}`);
    expect(text.stdout).toContain("feat--login");
  });
});

test("in a folder that is not a codebase or project it fails with not-a-codebase", async () => {
  const elsewhere = join(iso.root, "elsewhere");
  mkdirSync(elsewhere);
  const result = await json(LIST, elsewhere);
  expect(result.code).toBe(1);
  expect(result.data.error.code).toBe("not-a-codebase");
});

test("the git guard of these tests throws on any git call", () => {
  const git = gitAdapter.createGit({ interactive: false, env: {} });
  expect(() => git.version()).toThrow("git version must not run");
});

test("takes no lock and makes no git call", async () => {
  twoProjects();
  // A lock held by a running process: a command that takes the lock fails.
  const lockFile = writeFile(
    join(codebase, ".crossrepo", "xr.lock"),
    `${process.ppid}\n`,
  );
  expect((await run(LIST)).code).toBe(0);
  expect((await json(LIST)).code).toBe(0);
  expect(readFileSync(lockFile, "utf8")).toBe(`${process.ppid}\n`);
});

test("an extra argument is a usage error", async () => {
  const result = await run([...LIST, "x"]);
  expect(result.code).toBe(2);
});
