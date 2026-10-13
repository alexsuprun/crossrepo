import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { main } from "../../../../src/cli/index.ts";
import { makeRepos } from "../../../helpers/git.ts";
import {
  type Isolation,
  isolate,
  writeFile,
} from "../../../helpers/isolate.ts";

let iso: Isolation;
let codebase: string;
let configFile: string;

beforeEach(() => {
  iso = isolate();
  codebase = join(iso.root, "shop");
  configFile = join(codebase, ".crossrepo", "config.yaml");
});

afterEach(() => {
  iso.restore();
});

async function run(argv: string[], cwd = codebase) {
  let stdout = "";
  let stderr = "";
  const code = await main({
    version: "1.2.3",
    argv,
    env: {},
    isTTY: { stdin: false, stdout: false, stderr: false },
    cwd,
    home: iso.home,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

async function json(argv: string[], cwd = codebase) {
  const result = await run(["--json", ...argv], cwd);
  return { ...result, data: JSON.parse(result.stdout) };
}

const LIST = ["codebase", "repo", "list"];

/** Every file under `dir` with its text, skipping the inside of `.git` folders. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    if (/(^|[\\/])\.git([\\/]|$)/.test(name)) continue;
    const path = join(dir, name);
    files[name] = statSync(path).isDirectory()
      ? "<dir>"
      : readFileSync(path, "utf8");
  }
  return files;
}

/** A codebase config with `web` before `api`, so config order is not name order. */
function twoRepos(remotes: Record<string, string | undefined>) {
  writeFile(
    configFile,
    [
      "repos:",
      "  web:",
      `    remote: ${remotes.web}`,
      "    default-branch: main",
      "    description: The site",
      "  api:",
      `    remote: ${remotes.api}`,
      "    default-branch: main",
      "",
    ].join("\n"),
  );
}

describe("xr codebase repo list with all repos present", () => {
  test("--json is exactly ok, warnings and entries, in config order", async () => {
    const remotes = makeRepos(codebase, { web: {}, api: {} });
    twoRepos(remotes);
    const result = await json(LIST);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.data).toEqual({
      ok: true,
      warnings: [],
      entries: [
        {
          repo: "web",
          remote: remotes.web,
          defaultBranch: "main",
          description: "The site",
          present: true,
        },
        {
          repo: "api",
          remote: remotes.api,
          defaultBranch: "main",
          description: "",
          present: true,
        },
      ],
    });
    expect(Object.keys(result.data)).toEqual(["ok", "warnings", "entries"]);
  });

  test("text mode prints one aligned row per repo with ✓, and nothing else", async () => {
    writeFile(
      configFile,
      "repos:\n  web:\n    remote: w.git\n    default-branch: trunk\n    description: Site\n  api:\n    remote: api.git\n    default-branch: main\n",
    );
    makeRepos(codebase, { web: { origin: false }, api: { origin: false } });
    const result = await run(LIST);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      "web  w.git    trunk  Site  ✓\napi  api.git  main         ✓\n",
    );
  });

  test("changes no file and makes no folder", async () => {
    const remotes = makeRepos(codebase, { web: {}, api: {} });
    twoRepos(remotes);
    const before = snapshot(codebase);
    await run(LIST);
    await json(LIST);
    expect(snapshot(codebase)).toEqual(before);
  });
});

test("a remote in config.local.yaml wins", async () => {
  const remotes = makeRepos(codebase, { web: {}, api: {} });
  twoRepos(remotes);
  writeFile(
    join(codebase, ".crossrepo", "config.local.yaml"),
    "repos:\n  api:\n    remote: git@example.com:me/api.git\n",
  );
  const { data } = await json(LIST);
  expect(data.entries[1]).toEqual({
    repo: "api",
    remote: "git@example.com:me/api.git",
    defaultBranch: "main",
    description: "",
    present: true,
  });
});

describe("repos that are not on disk", () => {
  test("a missing folder is present false with one clone note", async () => {
    const remotes = makeRepos(codebase, { api: {} });
    twoRepos({ ...remotes, web: "/o/web.git" });
    const result = await json(LIST);
    expect(result.code).toBe(0);
    expect(
      result.data.entries.map((e: { present: boolean }) => e.present),
    ).toEqual([false, true]);
    expect(result.data.notes).toEqual([
      "Clone the missing repos with `xr codebase clone`.",
    ]);
    const text = await run(LIST);
    expect(text.code).toBe(0);
    const width = Math.max("/o/web.git".length, `${remotes.api}`.length);
    expect(text.stdout).toBe(
      [
        `web  ${"/o/web.git".padEnd(width)}  main  The site  –`,
        `api  ${`${remotes.api}`.padEnd(width)}  main            ✓`,
        "",
        "Clone the missing repos with `xr codebase clone`.",
        "",
      ].join("\n"),
    );
  });

  test("two missing repos still give one clone note", async () => {
    twoRepos({ web: "/o/web.git", api: "/o/api.git" });
    const { data } = await json(LIST);
    expect(data.notes).toEqual([
      "Clone the missing repos with `xr codebase clone`.",
    ]);
  });

  test("a folder with no .git is present false with a note to move or delete it", async () => {
    twoRepos({ web: "/o/web.git", api: "/o/api.git" });
    writeFile(join(codebase, "web", "index.html"), "");
    writeFile(join(codebase, "api", "README.md"), "");
    const result = await json(LIST);
    expect(result.code).toBe(0);
    expect(
      result.data.entries.map((e: { present: boolean }) => e.present),
    ).toEqual([false, false]);
    expect(result.data.notes).toEqual([
      "The folder `web` has no `.git`, so `xr codebase clone` cannot use it. Move or delete it.",
      "The folder `api` has no `.git`, so `xr codebase clone` cannot use it. Move or delete it.",
    ]);
  });

  test("a .git file, as in a linked worktree, counts as present", async () => {
    twoRepos({ web: "/o/web.git", api: "/o/api.git" });
    writeFile(join(codebase, "web", ".git"), "gitdir: /elsewhere\n");
    writeFile(join(codebase, "api", ".git", "HEAD"), "ref: refs/heads/main\n");
    const { data } = await json(LIST);
    expect(data.entries.map((e: { present: boolean }) => e.present)).toEqual([
      true,
      true,
    ]);
    expect(data.notes).toBeUndefined();
  });

  test("the clone note comes before the folder notes", async () => {
    twoRepos({ web: "/o/web.git", api: "/o/api.git" });
    writeFile(join(codebase, "web", "index.html"), "");
    const { data } = await json(LIST);
    expect(data.notes).toEqual([
      "Clone the missing repos with `xr codebase clone`.",
      "The folder `web` has no `.git`, so `xr codebase clone` cannot use it. Move or delete it.",
    ]);
  });
});

describe("a codebase with no repos", () => {
  for (const [label, text] of [
    ["an empty repos map", "repos: {}\n"],
    ["repos with no value", "repos:\n"],
    ["no repos key", "name: shop\n"],
  ] as const) {
    test(`${label} prints the add hint, and entries is empty in JSON`, async () => {
      writeFile(configFile, text);
      const result = await run(LIST);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe(
        "The codebase has no repos. Add one with `xr codebase repo add <url>|<folder>`.\n",
      );
      expect((await json(LIST)).data).toEqual({
        ok: true,
        warnings: [],
        entries: [],
        notes: [
          "The codebase has no repos. Add one with `xr codebase repo add <url>|<folder>`.",
        ],
      });
    });
  }
});

test("a repo with no keys set gives empty strings", async () => {
  writeFile(configFile, "repos:\n  api: {}\n");
  const { data } = await json(LIST);
  expect(data.entries).toEqual([
    {
      repo: "api",
      remote: "",
      defaultBranch: "",
      description: "",
      present: false,
    },
  ]);
});

test("in a project folder it lists the repos of the project's codebase", async () => {
  const remotes = makeRepos(codebase, { web: {}, api: {} });
  twoRepos(remotes);
  const project = join(codebase, ".projects", "feat");
  writeFile(join(project, ".crossrepo", "project.yaml"), "codebase: ../..\n");
  const result = await json(LIST, project);
  expect(result.code).toBe(0);
  expect(
    result.data.entries.map((e: { repo: string; present: boolean }) => [
      e.repo,
      e.present,
    ]),
  ).toEqual([
    ["web", true],
    ["api", true],
  ]);
});

test("runs as usual while the lock is held, and leaves the lock file as it is", async () => {
  const remotes = makeRepos(codebase, { web: {}, api: {} });
  twoRepos(remotes);
  const lockFile = writeFile(
    join(codebase, ".crossrepo", "xr.lock"),
    `${process.ppid}\n`,
  );
  const result = await json(LIST);
  expect(result.code).toBe(0);
  expect(result.data.entries).toHaveLength(2);
  expect(readFileSync(lockFile, "utf8")).toBe(`${process.ppid}\n`);
});

test("a folder that is not a codebase fails with not-a-codebase, as config show does", async () => {
  const result = await json(LIST, iso.root);
  expect(result.code).toBe(1);
  expect(result.data.error.code).toBe("not-a-codebase");
  const show = await json(["config", "show"], iso.root);
  expect(result.data.error).toEqual(show.data.error);
  const text = await run(LIST, iso.root);
  expect(text.code).toBe(1);
  expect(text.stdout).toBe("");
});

test("--codebase-path picks the codebase from any folder", async () => {
  writeFile(configFile, "repos:\n  api:\n    remote: a.git\n");
  const { code, data } = await json(
    ["--codebase-path", codebase, ...LIST],
    iso.home,
  );
  expect(code).toBe(0);
  expect(data.entries[0].repo).toBe("api");
});
