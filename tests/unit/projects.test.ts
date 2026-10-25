import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createFs } from "../../src/adapters/fs/index.ts";
import type { Ctx } from "../../src/domain/ctx.ts";
import { renderProjectRecord } from "../../src/domain/project-record.ts";
import type { LiveEvent } from "../../src/domain/report.ts";
import { XrError } from "../../src/errors/index.ts";
import {
  codebaseProjects,
  findProject,
  projectEntries,
} from "../../src/services/projects.ts";
import { type Isolation, isolate, writeFile } from "../helpers/isolate.ts";

let iso: Isolation;
let codebase: string;
let projectsDir: string;
let events: LiveEvent[];

beforeEach(() => {
  iso = isolate();
  codebase = join(iso.root, "shop");
  projectsDir = join(codebase, ".projects");
  mkdirSync(join(codebase, ".crossrepo"), { recursive: true });
  events = [];
});

afterEach(() => {
  iso.restore();
});

function ctx(): Pick<Ctx, "fs" | "config" | "out"> {
  return {
    fs: createFs(),
    out: { emit: (event) => events.push(event) },
    config: {
      entries: [],
      projectsDir: {
        value: ".projects",
        source: { kind: "default" },
        resolved: projectsDir,
      },
      repos: [],
      postCreate: [],
      vars: {},
    },
  };
}

function record(
  name: string,
  branch: string,
  repos: string[],
  { of = codebase, created = "2026-10-20T14:03:12Z" } = {},
): string {
  return writeFile(
    join(projectsDir, name, ".crossrepo", "project.yaml"),
    renderProjectRecord({ branch, codebase: of, repos, created }),
  );
}

describe("projectEntries", () => {
  test("gives each project of this codebase in name order with its full record", () => {
    record("fix--bug", "fix/bug", ["api"]);
    record("feat--login", "feat/login", ["web", "api"]);
    expect(projectEntries(ctx(), codebase)).toEqual([
      {
        name: "feat--login",
        path: join(projectsDir, "feat--login"),
        branch: "feat/login",
        repos: ["web", "api"],
        created: "2026-10-20T14:03:12Z",
      },
      {
        name: "fix--bug",
        path: join(projectsDir, "fix--bug"),
        branch: "fix/bug",
        repos: ["api"],
        created: "2026-10-20T14:03:12Z",
      },
    ]);
  });

  test("leaves out a project of another codebase and a folder with no record", () => {
    const other = join(iso.root, "other");
    mkdirSync(join(other, ".crossrepo"), { recursive: true });
    record("theirs", "theirs", ["api"], { of: other });
    mkdirSync(join(projectsDir, "plain"), { recursive: true });
    record("mine", "mine", ["api"]);
    expect(projectEntries(ctx(), codebase).map(({ name }) => name)).toEqual([
      "mine",
    ]);
  });

  test("a missing projects-dir has no projects", () => {
    expect(projectEntries(ctx(), codebase)).toEqual([]);
  });

  test("strict: a record with no branch throws invalid-project-record", () => {
    writeFile(
      join(projectsDir, "old", ".crossrepo", "project.yaml"),
      `codebase: ${codebase}\nrepos:\n  - api\n`,
    );
    expect(() => projectEntries(ctx(), codebase)).toThrow(
      expect.objectContaining({ code: "invalid-project-record" }),
    );
  });

  test("lenient: a broken record is a live warning with its path, and the others stay", () => {
    const bad = writeFile(
      join(projectsDir, "bad", ".crossrepo", "project.yaml"),
      "branch: [\n",
    );
    const old = writeFile(
      join(projectsDir, "old", ".crossrepo", "project.yaml"),
      `codebase: ${codebase}\nrepos:\n  - api\n`,
    );
    record("good", "good", ["api"]);
    const entries = projectEntries(ctx(), codebase, { lenient: true });
    expect(entries.map(({ name }) => name)).toEqual(["good"]);
    expect(events).toHaveLength(2);
    const [first, second] = events.map((event) =>
      event.type === "warning" ? event.warning : undefined,
    );
    expect(first?.code).toBe("invalid-project-record");
    expect(first?.message).toContain(bad);
    expect(first?.hint).toBeString();
    expect(second?.code).toBe("invalid-project-record");
    expect(second?.message).toContain(old);
  });

  test("an old record with no created has no created", () => {
    writeFile(
      join(projectsDir, "old", ".crossrepo", "project.yaml"),
      `branch: old\ncodebase: ${codebase}\nrepos:\n  - api\n`,
    );
    const [entry] = projectEntries(ctx(), codebase);
    expect(entry).toEqual({
      name: "old",
      path: join(projectsDir, "old"),
      branch: "old",
      repos: ["api"],
    });
  });
});

describe("codebaseProjects", () => {
  test("stays strict and still reads a record with no branch", () => {
    writeFile(
      join(projectsDir, "old", ".crossrepo", "project.yaml"),
      `codebase: ${codebase}\nrepos:\n  - api\n`,
    );
    expect(codebaseProjects(ctx(), codebase)).toEqual([
      { name: "old", repos: ["api"] },
    ]);
    writeFile(
      join(projectsDir, "bad", ".crossrepo", "project.yaml"),
      "branch: [\n",
    );
    expect(() => codebaseProjects(ctx(), codebase)).toThrow(
      expect.objectContaining({ code: "invalid-project-record" }),
    );
  });
});

describe("findProject", () => {
  beforeEach(() => {
    record("feat--login", "feat/login", ["api"]);
    record("feat--x", "feat/x", ["api"]);
  });

  test("finds by folder name", () => {
    expect(findProject(ctx(), codebase, "feat--login").name).toBe(
      "feat--login",
    );
  });

  test("finds by branch", () => {
    expect(findProject(ctx(), codebase, "feat/login").name).toBe("feat--login");
  });

  test("the folder name wins over a branch", () => {
    // `aaa` sorts first, so a one-pass lookup would give it.
    record("aaa", "feat--x", ["api"]);
    expect(findProject(ctx(), codebase, "feat--x").name).toBe("feat--x");
  });

  test("an unknown name is project-not-found with the list hint", () => {
    let thrown: unknown;
    try {
      findProject(ctx(), codebase, "nope");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(XrError);
    expect(thrown).toMatchObject({
      code: "project-not-found",
      hint: "Run `xr project list` to see the projects.",
      details: { project: "nope" },
    });
  });
});
