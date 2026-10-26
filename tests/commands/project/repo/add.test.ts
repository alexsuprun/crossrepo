import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as promptAdapter from "../../../../src/adapters/prompt/index.ts";
import { afterCall, withFault } from "../../../helpers/faults.ts";
import { git } from "../../../helpers/git.ts";
import { writeFile } from "../../../helpers/isolate.ts";
import {
  outsideSections,
  useProjectRepoEnv,
} from "../../../helpers/project-repo.ts";
import { fakeKeys, fakePick, fakePickMany } from "../../../helpers/prompt.ts";

const t = useProjectRepoEnv();
const { env } = t;
const ADD = ["project", "repo", "add"];

const added = (repo: string, message = "new branch from origin/main") => ({
  repo,
  status: "ok",
  message,
  source: "new",
});

describe("xr project repo add: success", () => {
  test("one repo in the project folder: worktree, record and AGENTS.md", async () => {
    const before = t.record();
    const result = await t.json([...ADD, "web"], { cwd: env.login });
    expect(result.code).toBe(0);
    expect(result.data).toEqual({
      ok: true,
      warnings: [],
      project: env.login,
      branch: "feat/login",
      repos: [added("web")],
    });
    expect(t.worktreePaths("web")).toEqual([
      join(env.codebase, "web"),
      join(env.login, "web"),
    ]);
    expect(git(join(env.login, "web"), "branch", "--show-current").trim()).toBe(
      "feat/login",
    );
    expect(t.recordRepos()).toEqual(["api", "web"]);
    // The old `created` stays.
    expect(t.record()).toContain(before.split("\n").at(-2) as string);
    const agents = t.agents();
    expect(agents).toContain("`api`");
    expect(agents).toContain("`web`");
    expect(agents).toContain("Web notes.");
    expect(agents).not.toContain("Docs notes.");
    expect(existsSync(env.lockFile)).toBe(false);
  });

  test("several repos in a codebase folder with --project: config order, once each", async () => {
    const result = await t.json([
      ...ADD,
      "docs",
      "web",
      "docs",
      "--project",
      "feat--login",
    ]);
    expect(result.code).toBe(0);
    expect(result.data.repos).toEqual([added("web"), added("docs")]);
    expect(t.recordRepos()).toEqual(["api", "web", "docs"]);
    const order = ["Add worktree web", "Add worktree docs"].map((line) =>
      result.stderr.indexOf(line),
    );
    expect(order[0]).toBeLessThan(order[1] as number);
  });

  test("--project by branch works too", async () => {
    const result = await t.json([...ADD, "web", "--project", "feat/login"]);
    expect(result.code).toBe(0);
    expect(t.recordRepos()).toEqual(["api", "web"]);
  });

  test("--project wins over the current project folder", async () => {
    const other = await t.run(["project", "create", "fix/bug", "api"]);
    expect(other.code).toBe(0);
    const bug = join(env.projects, "fix--bug");
    const result = await t.json([...ADD, "web", "--project", "fix--bug"], {
      cwd: env.login,
    });
    expect(result.code).toBe(0);
    expect(result.data.project).toBe(bug);
    expect(t.recordRepos(bug)).toEqual(["api", "web"]);
    expect(t.recordRepos()).toEqual(["api"]);
  });

  test("a branch that exists already: local branch, kept by the add", async () => {
    git(join(env.codebase, "web"), "branch", "feat/login");
    const result = await t.json([...ADD, "web"], { cwd: env.login });
    expect(result.code).toBe(0);
    expect(result.data.repos).toEqual([
      { repo: "web", status: "ok", message: "local branch", source: "local" },
    ]);
  });

  test("a record repo that the config does not list stays in the record", async () => {
    const file = join(env.login, ".crossrepo", "project.yaml");
    writeFile(file, t.record().replace("  - api\n", "  - api\n  - old\n"));
    const result = await t.json([...ADD, "web"], { cwd: env.login });
    expect(result.code).toBe(0);
    expect(t.recordRepos()).toEqual(["api", "web", "old"]);
  });

  test("text mode: the steps in order, then the Report", async () => {
    const result = await t.run([...ADD, "web"], { cwd: env.login });
    expect(result.code).toBe(0);
    const order = [
      "✓ Add worktree web",
      "✓ Write project record",
      "✓ Write AGENTS.md",
    ].map((line) => result.stderr.indexOf(line));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(result.stdout).toBe(
      [
        join(".projects", "feat--login"),
        "",
        "feat/login",
        "",
        "✓ web: new branch from origin/main",
        "",
      ].join("\n"),
    );
  });

  test("AGENTS.md: only the two sections change", async () => {
    const file = join(env.login, "AGENTS.md");
    writeFile(file, t.agents().replace("Mine.", "Mine.\n\nMy own line."));
    const before = t.agents();
    const result = await t.json([...ADD, "web"], { cwd: env.login });
    expect(result.code).toBe(0);
    const after = t.agents();
    expect(after).not.toBe(before);
    expect(outsideSections(after)).toBe(outsideSections(before));
    expect(after).toContain("My own line.");
  });

  test("runs no hook", async () => {
    const out = join(env.iso.root, "hook.txt");
    writeFile(
      env.configFile,
      `${t.configText()}project:\n  post-create:\n    - ${JSON.stringify(`touch "${out}"`)}\n`,
    );
    const result = await t.json([...ADD, "web"], { cwd: env.login });
    expect(result.code).toBe(0);
    expect(existsSync(out)).toBe(false);
  });
});

describe("xr project repo add: the project", () => {
  test("in a codebase folder with no --project, in a terminal: the project picker before the lock", async () => {
    const lockAtPick: boolean[] = [];
    const requests: promptAdapter.PickRequest[] = [];
    env.spies.push(
      spyOn(promptAdapter, "createPrompt").mockImplementation(() => ({
        pick: (request) => {
          requests.push(request);
          lockAtPick.push(existsSync(env.lockFile));
          return Promise.resolve("feat--login");
        },
      })),
    );
    const result = await t.run([...ADD, "web"], { tty: true });
    expect(result.code).toBe(0);
    expect(lockAtPick).toEqual([false]);
    expect(requests[0]).toMatchObject({
      argument: "project",
      choices: ["feat--login"],
      hints: { "feat--login": "feat/login" },
    });
    expect(t.recordRepos()).toEqual(["api", "web"]);
  });

  test("Escape in the project picker: interrupted, exit 130, nothing changes", async () => {
    fakeKeys(env.spies, ["\x1b"]);
    const before = t.state();
    const result = await t.run([...ADD, "web"], { tty: true });
    expect(result.code).toBe(130);
    expect(t.state()).toEqual(before);
  });

  test("no --project, not interactive: missing-argument with the project names, exit 2", async () => {
    const before = t.state();
    const result = await t.json([...ADD, "web"]);
    expect(result.code).toBe(2);
    expect(result.data.error.code).toBe("missing-argument");
    expect(result.data.error.details).toEqual({
      argument: "project",
      choices: ["feat--login"],
    });
    expect(t.state()).toEqual(before);
  });

  test("a project gone before the lock is taken: project-not-found, no lock left", async () => {
    env.spies.push(
      spyOn(promptAdapter, "createPrompt").mockImplementation(() => ({
        pick: () => {
          rmSync(join(env.login, ".crossrepo"), { recursive: true });
          return Promise.resolve("feat--login");
        },
      })),
    );
    // The fake picks also with --json, so the error code is in the JSON.
    const result = await t.json([...ADD, "web"]);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("project-not-found");
    expect(result.data.error.message).toBe("The project feat--login is gone.");
    expect(existsSync(env.lockFile)).toBe(false);
  });

  test("an unknown --project: project-not-found", async () => {
    const result = await t.json([...ADD, "web", "--project", "nope"]);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("project-not-found");
  });

  test("outside a codebase: not-a-codebase", async () => {
    const result = await t.json([...ADD, "web"], { cwd: env.iso.root });
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("not-a-codebase");
  });
});

describe("xr project repo add: the repo picker", () => {
  test("in a terminal: the on-disk repos not in the project, in config order", async () => {
    const requests = fakePickMany(env.spies, ["docs"]);
    const result = await t.run(ADD, { cwd: env.login, tty: true });
    expect(result.code).toBe(0);
    expect(requests[0]).toMatchObject({
      argument: "repos",
      choices: ["web", "docs"],
    });
    expect(t.recordRepos()).toEqual(["api", "docs"]);
  });

  test("a repo not on disk is not a choice", async () => {
    rmSync(join(env.codebase, "docs"), { recursive: true });
    const requests = fakePickMany(env.spies, ["web"]);
    const result = await t.run(ADD, { cwd: env.login, tty: true });
    expect(result.code).toBe(0);
    expect(requests[0]?.choices).toEqual(["web"]);
  });

  test("the project picker comes first, then the repo picker", async () => {
    fakePick(env.spies, "feat--login");
    const requests = fakePickMany(env.spies, ["web"]);
    const result = await t.run(ADD, { tty: true });
    expect(result.code).toBe(0);
    expect(requests[0]?.choices).toEqual(["web", "docs"]);
  });

  test("not interactive: missing-argument with these repos, exit 2", async () => {
    const before = t.state();
    const result = await t.json(ADD, { cwd: env.login });
    expect(result.code).toBe(2);
    expect(result.data.error.code).toBe("missing-argument");
    expect(result.data.error.details).toEqual({
      argument: "repos",
      choices: ["web", "docs"],
    });
    expect(t.state()).toEqual(before);
  });

  for (const tty of [true, false]) {
    test(`nothing left to add, tty ${tty}: the empty message and the clone hint`, async () => {
      expect(
        (await t.json([...ADD, "web", "docs"], { cwd: env.login })).code,
      ).toBe(0);
      fakeKeys(env.spies, []);
      const result = await t.run(ADD, { cwd: env.login, tty });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(
        "Every repo on disk is in the project already.",
      );
      expect(result.stderr).toContain("xr codebase clone");
    });
  }
});

describe("xr project repo add: checks change nothing", () => {
  test("an unknown repo: repo-not-found with the list hint", async () => {
    const before = t.state();
    const result = await t.json([...ADD, "web", "nope"], { cwd: env.login });
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("repo-not-found");
    expect(result.data.error.hint).toContain("xr codebase repo list");
    expect(t.state()).toEqual(before);
  });

  test("a repo not on disk: the clone hint", async () => {
    rmSync(join(env.codebase, "docs"), { recursive: true });
    const before = t.state();
    const result = await t.json([...ADD, "web", "docs"], { cwd: env.login });
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("repos-not-ready");
    expect(result.data.error.hint).toContain("xr codebase clone");
    expect(t.state()).toEqual(before);
  });

  test("a repo in the project already: repo-already-in-project, exit 1", async () => {
    const before = t.state();
    const result = await t.json([...ADD, "web", "api"], { cwd: env.login });
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("repo-already-in-project");
    expect(result.data.error.message).toContain("api");
    expect(result.data.error.hint).toBe(
      "See the repos of the project with `xr project repo list --project feat--login`.",
    );
    expect(t.state()).toEqual(before);
  });

  for (const kind of ["folder", "file"]) {
    test(`a ${kind} at the worktree path: project-drift`, async () => {
      const path = join(env.login, "web");
      if (kind === "folder") mkdirSync(path);
      else writeFile(path, "x\n");
      const before = t.state();
      const result = await t.json([...ADD, "web"], { cwd: env.login });
      expect(result.code).toBe(1);
      expect(result.data.error.code).toBe("project-drift");
      expect(result.data.error.hint).toContain("Move");
      expect(t.state()).toEqual(before);
    });
  }

  test("the branch checked out in the codebase repo: branch-in-use", async () => {
    git(join(env.codebase, "web"), "checkout", "--quiet", "-b", "feat/login");
    const before = t.state();
    const result = await t.json([...ADD, "docs", "web"], { cwd: env.login });
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("branch-in-use");
    expect(t.state()).toEqual(before);
  });

  test("a failed fetch: git-failed", async () => {
    git(
      join(env.codebase, "docs"),
      "remote",
      "set-url",
      "origin",
      join(env.iso.root, "gone.git"),
    );
    const before = t.state();
    const result = await t.json([...ADD, "web", "docs"], { cwd: env.login });
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("git-failed");
    expect(t.state()).toEqual(before);
  });

  test("a held lock: lock-held", async () => {
    writeFile(env.lockFile, `${process.ppid}\n`);
    const before = t.state();
    const result = await t.json([...ADD, "web"], { cwd: env.login });
    expect(result.data.error.code).toBe("lock-held");
    expect(t.state()).toEqual(before);
  });
});

describe("xr project repo add: undo", () => {
  test("a failed 2nd worktree add: full undo, the new branch deleted, record and AGENTS.md as before", async () => {
    t.fakeGit((g) => withFault(g, "worktreeAdd", 2));
    const before = t.state();
    const result = await t.json([...ADD, "web", "docs"], { cwd: env.login });
    expect(result.code).toBe(1);
    expect(result.data.error.message).toContain("fault in worktreeAdd");
    expect(t.state()).toEqual(before);
    expect(t.branches("web")).toEqual(["main"]);
  });

  test("a failed AGENTS.md write: the record is written back", async () => {
    const before = t.state();
    let calls = 0;
    const fsAdapter = await import("../../../../src/adapters/fs/index.ts");
    const real = fsAdapter.createFs;
    env.spies.push(
      spyOn(fsAdapter, "createFs").mockImplementation(() => {
        const fs = real();
        return {
          ...fs,
          writeText(path: string, text: string) {
            if (path.endsWith("AGENTS.md")) {
              calls += 1;
              if (calls === 1) throw new Error("fault in AGENTS.md write");
            }
            fs.writeText(path, text);
          },
        };
      }),
    );
    const result = await t.json([...ADD, "web"], { cwd: env.login });
    expect(result.code).toBe(1);
    expect(result.data.error.message).toContain("fault in AGENTS.md write");
    expect(t.state()).toEqual(before);
  });

  test("Ctrl-C after the 1st worktree add: full undo, exit 130", async () => {
    t.fakeGit((g) =>
      afterCall(g, "worktreeAdd", 1, () => env.interrupts.fire()),
    );
    const before = t.state();
    const result = await t.json([...ADD, "web", "docs"], { cwd: env.login });
    expect(result.code).toBe(130);
    expect(result.data.error.code).toBe("interrupted");
    expect(t.state()).toEqual(before);
    expect(existsSync(env.lockFile)).toBe(false);
    expect(readdirSync(env.login).sort()).toEqual(before.login ?? []);
  });
});
