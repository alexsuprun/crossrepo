import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  type Isolation,
  isolate,
  writeFile,
} from "../../../helpers/isolate.ts";
import { forbidGit, makeProject, runXr } from "../../../helpers/projects.ts";
import { fakePick } from "../../../helpers/prompt.ts";

let iso: Isolation;
let codebase: string;
let projects: string;
let login: string;
let spies: { mockRestore(): void }[];

const LIST = ["project", "repo", "list"];

beforeEach(() => {
  iso = isolate();
  codebase = join(iso.root, "shop");
  projects = join(codebase, ".projects");
  writeFile(
    join(codebase, ".crossrepo", "config.yaml"),
    [
      "repos:",
      "  api:",
      "    remote: a.git",
      "    description: Public REST API",
      "  web:",
      "    remote: w.git",
      "    description: Frontend",
      "  docs:",
      "    remote: d.git",
      "    description: Docs site",
      "  tools:",
      "    remote: t.git",
      "",
    ].join("\n"),
  );
  login = makeProject(projects, "feat--login", "feat/login", ["api", "web"], {
    codebase,
  });
  // A record repo with no worktree folder.
  makeProject(projects, "feat--login", "feat/login", ["api", "web", "docs"], {
    codebase,
    folders: false,
  });
  makeProject(projects, "fix--bug", "fix/bug", ["tools"], { codebase });
  spies = [forbidGit()];
  // A live process holds the lock, so a command that takes it fails.
  writeFile(join(codebase, ".crossrepo", "xr.lock"), `${process.ppid}\n`);
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  iso.restore();
});

const run = (argv: string[], cwd = codebase, tty = false) =>
  runXr({ argv, cwd, home: iso.home, tty });

async function json(argv: string[], cwd = codebase) {
  const result = await run(["--json", ...argv], cwd);
  return { ...result, data: JSON.parse(result.stdout) };
}

const LOGIN_TEXT = [
  "✓ api    Public REST API",
  "✓ web    Frontend",
  "– docs   worktree folder missing",
  "",
].join("\n");

describe("xr project repo list", () => {
  test("in a project folder: one line per record repo, no git, no lock", async () => {
    const result = await run(LIST, login);
    expect(result).toEqual({ code: 0, stdout: LOGIN_TEXT, stderr: "" });
  });

  test("--json: the project name and the entries with absolute paths", async () => {
    const result = await json(LIST, login);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      `${JSON.stringify({
        ok: true,
        warnings: [],
        project: "feat--login",
        entries: [
          {
            repo: "api",
            path: join(login, "api"),
            present: true,
            description: "Public REST API",
          },
          {
            repo: "web",
            path: join(login, "web"),
            present: true,
            description: "Frontend",
          },
          {
            repo: "docs",
            path: join(login, "docs"),
            present: false,
            description: "Docs site",
          },
        ],
      })}\n`,
    );
  });

  test("a repo with no description: an empty description, null in JSON", async () => {
    const text = await run(LIST, join(projects, "fix--bug"));
    expect(text.stdout).toBe("✓ tools\n");
    const result = await json(LIST, join(projects, "fix--bug"));
    expect(result.data.entries[0].description).toBeNull();
  });

  test("in a codebase folder with --project", async () => {
    const result = await run([...LIST, "--project", "feat/login"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(LOGIN_TEXT);
  });

  test("--project wins in a project folder", async () => {
    const result = await run([...LIST, "--project", "fix--bug"], login);
    expect(result.stdout).toBe("✓ tools\n");
  });

  test("in a codebase folder, in a terminal: the project picker", async () => {
    const requests = fakePick(spies, "feat--login");
    const result = await run(LIST, codebase, true);
    expect(result.code).toBe(0);
    expect(requests[0]).toMatchObject({
      argument: "project",
      choices: ["feat--login", "fix--bug"],
      hints: { "feat--login": "feat/login", "fix--bug": "fix/bug" },
    });
    // A terminal gets colors.
    expect(stripVTControlCharacters(result.stdout)).toBe(LOGIN_TEXT);
  });

  test("in a codebase folder, not interactive: missing-argument, exit 2", async () => {
    const result = await json(LIST);
    expect(result.code).toBe(2);
    expect(result.data.error.details).toEqual({
      argument: "project",
      choices: ["feat--login", "fix--bug"],
    });
  });

  test("an unknown --project: project-not-found", async () => {
    const result = await json([...LIST, "--project", "nope"]);
    expect(result.data.error.code).toBe("project-not-found");
  });

  test("outside a codebase: not-a-codebase", async () => {
    const result = await json(LIST, iso.root);
    expect(result.data.error.code).toBe("not-a-codebase");
  });
});
