import { describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as promptAdapter from "../../../src/adapters/prompt/index.ts";
import { git } from "../../helpers/git.ts";
import { writeFile } from "../../helpers/isolate.ts";
import { useProjectRepoEnv } from "../../helpers/project-repo.ts";

const t = useProjectRepoEnv();
const { env } = t;
const DOCTOR = ["project", "doctor"];
const CODEBASE_IDS = [
  "unknown-config-key",
  "reserved-var-name",
  "repo-not-in-config",
  "repo-folder-missing",
  "agents-heading-no-repo",
  "agents-repo-no-heading",
  "stale-worktree",
];
const PROJECT_IDS = [
  "project-record",
  "codebase-path",
  "worktree-missing",
  "worktree-not-registered",
  "worktree-branch",
  "project-drift",
  "project-agents-md",
];
const ALL_OK = [...CODEBASE_IDS, ...PROJECT_IDS].map((id) => ({
  id,
  status: "ok",
}));

const recordFile = () => join(env.login, ".crossrepo", "project.yaml");
const wt = (repo: string) => join(env.login, repo);

interface Item {
  id: string;
  status: string;
  message?: string;
  fix?: string;
}

const itemsOf = (data: { checks: Item[] }, id: string) =>
  data.checks.filter((item) => item.id === id);

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

function gitRefs(repo: string) {
  const dir = join(env.codebase, repo);
  return {
    refs: git(dir, "for-each-ref"),
    worktrees: git(dir, "worktree", "list", "--porcelain"),
  };
}

describe("xr project doctor: the project", () => {
  test("a healthy project in its folder: the project path and 14 ok items, exit 0", async () => {
    const result = await t.json(DOCTOR, { cwd: env.login });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      `${JSON.stringify({
        ok: true,
        warnings: [],
        project: env.login,
        checks: ALL_OK,
      })}\n`,
    );
    const text = await t.run(DOCTOR, { cwd: env.login });
    expect(text.code).toBe(0);
    expect(text.stdout).toBe(
      [
        join(".projects", "feat--login"),
        "",
        ...ALL_OK.map(({ id }) => `✓ ${id}`),
        "",
      ].join("\n"),
    );
  });

  test("in a codebase folder by name or by branch", async () => {
    for (const name of ["feat--login", "feat/login"]) {
      const result = await t.json([...DOCTOR, name]);
      expect(result.code).toBe(0);
      expect(result.data.project).toBe(env.login);
      expect(result.data.checks).toEqual(ALL_OK);
    }
  });

  test("an unknown name: project-not-found", async () => {
    const result = await t.json([...DOCTOR, "nope"]);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("project-not-found");
    expect(result.data.checks).toBeUndefined();
  });

  test("in a codebase folder with no name, in a terminal: the picker before any check, no lock", async () => {
    const requests: promptAdapter.PickRequest[] = [];
    env.spies.push(
      spyOn(promptAdapter, "createPrompt").mockImplementation(() => ({
        pick: (request) => {
          requests.push(request);
          return Promise.resolve("feat--login");
        },
      })),
    );
    const result = await t.run(DOCTOR, { tty: true });
    expect(result.code).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      argument: "project",
      message: "Pick the project to check",
      choices: ["feat--login"],
      hints: { "feat--login": "feat/login" },
      missing: "Give the project to check.",
      hint: "xr project doctor <project>",
    });
    expect(existsSync(env.lockFile)).toBe(false);
  });

  test("in a codebase folder with no name, not interactive: missing-argument, exit 2", async () => {
    const result = await t.json(DOCTOR);
    expect(result.code).toBe(2);
    expect(result.data.error.code).toBe("missing-argument");
    expect(result.data.error.details).toEqual({
      argument: "project",
      choices: ["feat--login"],
    });
    expect(result.data.checks).toBeUndefined();
  });

  test("a folder that is not a codebase or project: not-a-codebase, nothing runs", async () => {
    const result = await t.json(DOCTOR, { cwd: env.iso.root });
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("not-a-codebase");
    expect(result.data.checks).toBeUndefined();
  });

  test("two arguments are a usage error", async () => {
    const result = await t.run([...DOCTOR, "a", "b"]);
    expect(result.code).toBe(2);
  });

  test("an unknown config key is a warn item, not a live warning", async () => {
    writeFile(env.configFile, `${t.configText()}repo: 1\n`);
    const result = await t.json(DOCTOR, { cwd: env.login });
    expect(result.code).toBe(0);
    expect(result.data.warnings).toEqual([]);
    expect(result.data.checks[0]).toMatchObject({
      id: "unknown-config-key",
      status: "warn",
    });
  });
});

describe("xr project doctor: problems", () => {
  test("a deleted worktree folder: worktree-missing with remove and add, checks-failed", async () => {
    rmSync(wt("api"), { recursive: true, force: true });
    const result = await t.json(DOCTOR, { cwd: env.login });
    expect(result.code).toBe(1);
    expect(result.data.error).toEqual({
      code: "checks-failed",
      message: "1 check failed",
    });
    expect(Object.keys(result.data)).toEqual([
      "ok",
      "warnings",
      "project",
      "checks",
      "error",
    ]);
    expect(itemsOf(result.data, "worktree-missing")).toEqual([
      {
        id: "worktree-missing",
        status: "error",
        message: "api",
        fix: "xr project repo remove api --project feat--login\nxr project repo add api --project feat--login",
      },
    ]);
    const text = await t.run(DOCTOR, { cwd: env.login });
    expect(text.stdout).toBe("");
    expect(text.stderr).toContain(
      [
        "✗ worktree-missing  api",
        "    fix: xr project repo remove api --project feat--login",
        "      xr project repo add api --project feat--login",
      ].join("\n"),
    );
    expect(text.stderr).toStartWith(`${join(".projects", "feat--login")}\n`);
    expect(text.stderr).toEndWith("error: 1 check failed\n");
  });

  test("a moved project folder: worktree-not-registered with the repair fix, stale-worktree for the old path; after the repair, exit 0", async () => {
    const old = env.login;
    const moved = join(env.projects, "moved");
    renameSync(old, moved);
    const api = join(env.codebase, "api");
    const result = await t.json(DOCTOR, { cwd: moved });
    expect(result.code).toBe(1);
    expect(itemsOf(result.data, "worktree-not-registered")).toEqual([
      {
        id: "worktree-not-registered",
        status: "error",
        message: join(moved, "api"),
        fix: `git -C "${api}" worktree repair "${join(moved, "api")}"`,
      },
    ]);
    expect(itemsOf(result.data, "stale-worktree")).toEqual([
      {
        id: "stale-worktree",
        status: "warn",
        message: join(old, "api"),
        fix: `git -C "${api}" worktree prune`,
      },
    ]);
    git(api, "worktree", "repair", join(moved, "api"));
    const fixed = await t.json(DOCTOR, { cwd: moved });
    expect(fixed.code).toBe(0);
    expect(fixed.data.checks).toEqual(ALL_OK);
  });

  test("a worktree on another branch: worktree-branch warn, says sync refuses it, exit 0", async () => {
    git(wt("api"), "switch", "--quiet", "-c", "other");
    const result = await t.json(DOCTOR, { cwd: env.login });
    expect(result.code).toBe(0);
    expect(itemsOf(result.data, "worktree-branch")).toEqual([
      {
        id: "worktree-branch",
        status: "warn",
        message: `${wt("api")}: on branch \`other\`, not \`feat/login\`; \`xr project sync\` refuses this worktree`,
        fix: `git -C "${wt("api")}" switch feat/login`,
      },
    ]);
  });

  test("a detached HEAD: worktree-branch warn, exit 0", async () => {
    git(wt("api"), "switch", "--quiet", "--detach");
    const result = await t.json(DOCTOR, { cwd: env.login });
    expect(result.code).toBe(0);
    expect(itemsOf(result.data, "worktree-branch")[0]?.message).toContain(
      "detached HEAD",
    );
  });

  test("an extra folder: project-drift error; a dot folder: no item", async () => {
    mkdirSync(join(env.login, "tmp"));
    mkdirSync(join(env.login, ".idea"));
    const result = await t.json(DOCTOR, { cwd: env.login });
    expect(result.code).toBe(1);
    expect(itemsOf(result.data, "project-drift")).toEqual([
      {
        id: "project-drift",
        status: "error",
        message: "tmp",
        fix: "move `tmp` out of the project folder",
      },
    ]);
  });

  test("AGENTS.md drift: a stray heading and a missing repo heading are two warns, exit 0", async () => {
    const text = readFileSync(join(env.login, "AGENTS.md"), "utf8");
    writeFileSync(
      join(env.login, "AGENTS.md"),
      text.replace(/### api/i, "### old"),
    );
    const result = await t.json(DOCTOR, { cwd: env.login });
    expect(result.code).toBe(0);
    expect(itemsOf(result.data, "project-agents-md")).toEqual([
      {
        id: "project-agents-md",
        status: "warn",
        message: "old",
        fix: 'remove "### old" from "## Repos" in AGENTS.md',
      },
      {
        id: "project-agents-md",
        status: "warn",
        message: "api",
        fix: 'add "### api" under "## Repos" in AGENTS.md (copy it from the codebase AGENTS.md)',
      },
    ]);
  });

  test("a record without branch: project-record error, 2 to 7 skipped, codebase checks run", async () => {
    writeFileSync(
      recordFile(),
      t
        .record()
        .split("\n")
        .filter((line) => !line.startsWith("branch:"))
        .join("\n"),
    );
    const result = await t.json(DOCTOR, { cwd: env.login });
    expect(result.code).toBe(1);
    expect(result.data.checks).toEqual([
      ...CODEBASE_IDS.map((id) => ({ id, status: "ok" })),
      {
        id: "project-record",
        status: "error",
        message: `${recordFile()}: it has no \`branch\``,
        fix: "correct `.crossrepo/project.yaml`: keys branch, codebase, repos, created",
      },
      ...PROJECT_IDS.slice(1).map((id) => ({
        id,
        status: "skipped",
        message: "project record cannot be read",
      })),
    ]);
    const text = await t.run(DOCTOR, { cwd: env.login });
    expect(text.stderr).toContain(
      "– codebase-path  project record cannot be read\n",
    );
  });

  test("a record with invalid YAML: project-record error, every other check skipped", async () => {
    writeFileSync(recordFile(), "a: [\n");
    const result = await t.json(DOCTOR, { cwd: env.login });
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("checks-failed");
    expect(result.data.error.message).toBe("1 check failed");
    expect(result.data.project).toBe(env.login);
    const skipped = result.data.checks.filter(
      (item: Item) => item.status === "skipped",
    );
    expect(skipped).toHaveLength(13);
    expect(
      skipped.every(
        (item: Item) => item.message === "project record cannot be read",
      ),
    ).toBe(true);
    expect(itemsOf(result.data, "project-record")[0]?.status).toBe("error");
  });

  test("a moved codebase: codebase-path error with the repair lines; codebase checks and 4, 5, 7 skipped; 3 and 6 run", async () => {
    const moved = join(env.iso.root, "shop-moved");
    const gone = env.codebase;
    renameSync(gone, moved);
    const login = join(moved, ".projects", "feat--login");
    rmSync(join(login, "api"), { recursive: true, force: true });
    const result = await t.json(DOCTOR, { cwd: login });
    expect(result.code).toBe(1);
    expect(result.data.error.message).toBe("2 checks failed");
    const notFound = "codebase not found";
    expect(result.data.checks).toEqual([
      ...CODEBASE_IDS.map((id) => ({
        id,
        status: "skipped",
        message: notFound,
      })),
      { id: "project-record", status: "ok" },
      {
        id: "codebase-path",
        status: "error",
        message: gone,
        fix: [
          "set `codebase` in `.crossrepo/project.yaml` to the codebase folder, then run:",
          `git -C "<codebase>/api" worktree repair "${join(login, "api")}"`,
        ].join("\n"),
      },
      {
        id: "worktree-missing",
        status: "error",
        message: "api",
        fix: "xr project repo remove api --project feat--login\nxr project repo add api --project feat--login",
      },
      { id: "worktree-not-registered", status: "skipped", message: notFound },
      { id: "worktree-branch", status: "skipped", message: notFound },
      { id: "project-drift", status: "ok" },
      { id: "project-agents-md", status: "skipped", message: notFound },
    ]);
  });

  test("a broken project folder with a name: the discovery error", async () => {
    writeFileSync(recordFile(), "a: [\n");
    const result = await t.json([...DOCTOR, "feat--login"], {
      cwd: env.login,
    });
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("not-a-codebase");
    expect(result.data.error.message).toContain(recordFile());
    expect(result.data.checks).toBeUndefined();
  });

  test("many problems: no file, lock or git ref changes", async () => {
    git(wt("api"), "switch", "--quiet", "--detach");
    mkdirSync(join(env.login, "tmp"));
    rmSync(join(env.login, "AGENTS.md"));
    const files = snapshot(env.codebase);
    const before = gitRefs("api");
    const result = await t.run(DOCTOR, { cwd: env.login });
    expect(result.code).toBe(1);
    expect(snapshot(env.codebase)).toEqual(files);
    expect(gitRefs("api")).toEqual(before);
    expect(existsSync(env.lockFile)).toBe(false);
  });
});

describe("other commands in a broken project folder", () => {
  test("fail with the same error as before, and codebase init too", async () => {
    const gone = join(env.iso.root, "gone");
    writeFileSync(
      recordFile(),
      t
        .record()
        .replace(/^codebase: .*$/m, `codebase: ${JSON.stringify(gone)}`),
    );
    for (const argv of [
      ["project", "info"],
      ["codebase", "doctor"],
      ["codebase", "init"],
    ]) {
      const result = await t.json(argv, { cwd: env.login });
      expect(result.code).toBe(1);
      expect(result.data.error).toEqual({
        code: "not-a-codebase",
        message: `The project at ${env.login} points to ${gone}, which is not a codebase.`,
        hint: expect.stringContaining("--codebase-path <path>"),
      });
    }
  });
});
