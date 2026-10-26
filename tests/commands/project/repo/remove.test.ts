import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as promptAdapter from "../../../../src/adapters/prompt/index.ts";
import { afterCall, withFault } from "../../../helpers/faults.ts";
import { git } from "../../../helpers/git.ts";
import { writeFile } from "../../../helpers/isolate.ts";
import {
  outsideSections,
  useProjectRepoEnv,
} from "../../../helpers/project-repo.ts";
import { fakeKeys, fakePickMany } from "../../../helpers/prompt.ts";

const t = useProjectRepoEnv();
const { env } = t;
const REMOVE = ["project", "repo", "remove"];

// The project has api, web and docs.
beforeEach(async () => {
  const result = await t.run(["project", "repo", "add", "web", "docs"], {
    cwd: env.login,
  });
  if (result.code !== 0) throw new Error(result.stderr);
});

const kept = (repo: string) => ({
  repo,
  status: "ok",
  message: "worktree removed, branch kept",
  branchDeleted: false,
});

describe("xr project repo remove: success", () => {
  test("one repo in the project folder: worktree gone, branch kept, record and AGENTS.md without it", async () => {
    const created = t
      .record()
      .split("\n")
      .find((line) => line.startsWith("created:"));
    const result = await t.json([...REMOVE, "web"], { cwd: env.login });
    expect(result.code).toBe(0);
    expect(result.data).toEqual({
      ok: true,
      warnings: [],
      project: env.login,
      branch: "feat/login",
      repos: [kept("web")],
    });
    expect(t.worktreePaths("web")).toEqual([join(env.codebase, "web")]);
    expect(t.branches("web")).toEqual(["feat/login", "main"]);
    expect(existsSync(join(env.login, "web"))).toBe(false);
    expect(t.recordRepos()).toEqual(["api", "docs"]);
    expect(t.record()).toContain(created as string);
    expect(t.agents()).not.toContain("Web notes.");
    expect(t.agents()).not.toContain("`web`");
    expect(t.agents()).toContain("Docs notes.");
    expect(existsSync(env.lockFile)).toBe(false);
    expect(env.chdirs).toEqual([]);
  });

  test("several repos in a codebase folder with --project: record order, once each", async () => {
    const result = await t.json([
      ...REMOVE,
      "docs",
      "web",
      "docs",
      "--project",
      "feat/login",
    ]);
    expect(result.code).toBe(0);
    expect(result.data.repos).toEqual([kept("web"), kept("docs")]);
    expect(t.recordRepos()).toEqual(["api"]);
  });

  test("--project wins over the current project folder", async () => {
    expect(
      (await t.run(["project", "create", "fix/bug", "api", "web"])).code,
    ).toBe(0);
    const bug = join(env.projects, "fix--bug");
    const result = await t.json([...REMOVE, "web", "--project", "fix--bug"], {
      cwd: env.login,
    });
    expect(result.code).toBe(0);
    expect(result.data.project).toBe(bug);
    expect(t.recordRepos(bug)).toEqual(["api"]);
    expect(t.recordRepos()).toEqual(["api", "web", "docs"]);
  });

  test("text mode: the steps in delete order, then the Report", async () => {
    const result = await t.run([...REMOVE, "web", "--delete-branch"], {
      cwd: env.login,
    });
    expect(result.code).toBe(0);
    const order = [
      "✓ Remove worktree web",
      "✓ Delete branch web",
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
        "✓ web: worktree removed, branch deleted",
        "",
      ].join("\n"),
    );
  });

  test("AGENTS.md: only the two sections change", async () => {
    writeFile(
      join(env.login, "AGENTS.md"),
      t.agents().replace("Mine.", "Mine.\n\nMy own line."),
    );
    const before = t.agents();
    const result = await t.json([...REMOVE, "web"], { cwd: env.login });
    expect(result.code).toBe(0);
    const after = t.agents();
    expect(after).not.toBe(before);
    expect(outsideSections(after)).toBe(outsideSections(before));
  });

  test("--force with changes: the worktree goes with its changes", async () => {
    writeFile(join(env.login, "web", "new.txt"), "x\n");
    const result = await t.json([...REMOVE, "web", "--force"], {
      cwd: env.login,
    });
    expect(result.code).toBe(0);
    expect(existsSync(join(env.login, "web"))).toBe(false);
  });

  test("an extra folder elsewhere in the project is not checked", async () => {
    rmSync(join(env.login, "docs"), { recursive: true });
    writeFile(join(env.login, "notes", "a.txt"), "x\n");
    const result = await t.json([...REMOVE, "web"], { cwd: env.login });
    expect(result.code).toBe(0);
  });

  test("a missing worktree folder: git worktree prune, the step line says so, the record is updated", async () => {
    rmSync(join(env.login, "web"), { recursive: true });
    const result = await t.json([...REMOVE, "web"], { cwd: env.login });
    expect(result.code).toBe(0);
    expect(result.data.repos).toEqual([
      {
        repo: "web",
        status: "ok",
        message: "worktree folder missing, git entry pruned",
        branchDeleted: false,
      },
    ]);
    expect(result.stderr).toContain(
      "✓ Remove worktree web (worktree folder missing)",
    );
    expect(t.worktreePaths("web")).toEqual([join(env.codebase, "web")]);
    expect(t.recordRepos()).toEqual(["api", "docs"]);
  });

  test("runs no hook", async () => {
    const out = join(env.iso.root, "hook.txt");
    writeFile(
      env.configFile,
      `${t.configText()}project:\n  pre-remove:\n    - ${JSON.stringify(`touch "${out}"`)}\n`,
    );
    const result = await t.json([...REMOVE, "web"], { cwd: env.login });
    expect(result.code).toBe(0);
    expect(existsSync(out)).toBe(false);
  });
});

describe("xr project repo remove --delete-branch", () => {
  test("a merged branch is deleted", async () => {
    const result = await t.json([...REMOVE, "web", "--delete-branch"], {
      cwd: env.login,
    });
    expect(result.data.repos).toEqual([
      {
        repo: "web",
        status: "ok",
        message: "worktree removed, branch deleted",
        branchDeleted: true,
      },
    ]);
    expect(t.branches("web")).toEqual(["main"]);
  });

  test("an unmerged branch: kept, branch-not-merged warning with a branch -D hint, exit 0", async () => {
    git(
      join(env.login, "web"),
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "x",
    );
    const result = await t.json([...REMOVE, "web", "--delete-branch"], {
      cwd: env.login,
    });
    expect(result.code).toBe(0);
    const hint = `git -C "${join(env.codebase, "web")}" branch -D feat/login`;
    expect(result.data.repos).toEqual([
      {
        repo: "web",
        status: "ok",
        message: "worktree removed, branch kept: not merged",
        hint,
        branchDeleted: false,
      },
    ]);
    expect(result.data.warnings.map((w: { code: string }) => w.code)).toEqual([
      "branch-not-merged",
    ]);
    expect(t.branches("web")).toEqual(["feat/login", "main"]);
    expect(t.recordRepos()).toEqual(["api", "docs"]);
  });
});

describe("xr project repo remove: refused, nothing changes", () => {
  test("a repo not in the project: repo-not-found with the list hint", async () => {
    const before = t.state();
    const result = await t.json([...REMOVE, "web", "nope"], { cwd: env.login });
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("repo-not-found");
    expect(result.data.error.hint).toBe(
      "See the repos of the project with `xr project repo list --project feat--login`.",
    );
    expect(t.state()).toEqual(before);
  });

  test("every repo: last-repo with the project remove hint", async () => {
    const before = t.state();
    const result = await t.json([...REMOVE, "api", "web", "docs"], {
      cwd: env.login,
    });
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("last-repo");
    expect(result.data.error.hint).toContain("xr project remove");
    expect(t.state()).toEqual(before);
  });

  test("the last repo of a one-repo project: last-repo", async () => {
    expect((await t.run(["project", "create", "fix/bug", "api"])).code).toBe(0);
    const result = await t.json([...REMOVE, "api", "--project", "fix--bug"]);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("last-repo");
    expect(existsSync(join(env.projects, "fix--bug", "api"))).toBe(true);
  });

  test("uncommitted changes: uncommitted-changes, the hint names the repos and --force", async () => {
    writeFile(join(env.login, "web", "a.txt"), "1\n");
    const before = t.state();
    const result = await t.json([...REMOVE, "web", "docs"], { cwd: env.login });
    expect(result.code).toBe(1);
    const { error } = result.data;
    expect(error.code).toBe("uncommitted-changes");
    expect(error.hint).toBe(
      "Commit or stash the changes, or run `xr project repo remove web docs --project feat--login --force` to delete them.",
    );
    expect(error.details).toEqual({
      worktrees: [
        { repo: "web", path: join(env.login, "web"), files: ["a.txt"] },
      ],
    });
    expect(t.state()).toEqual(before);
  });

  test("uncommitted changes with --delete-branch: the hint keeps it", async () => {
    writeFile(join(env.login, "web", "a.txt"), "1\n");
    const result = await t.json([...REMOVE, "web", "--delete-branch"], {
      cwd: env.login,
    });
    expect(result.data.error.hint).toBe(
      "Commit or stash the changes, or run `xr project repo remove web --project feat--login --delete-branch --force` to delete them.",
    );
  });

  test("changes in a repo that stays do not count", async () => {
    writeFile(join(env.login, "api", "a.txt"), "1\n");
    const result = await t.json([...REMOVE, "web"], { cwd: env.login });
    expect(result.code).toBe(0);
  });
});

describe("xr project repo remove: the pickers", () => {
  test("in a terminal: a multi-select of the record repos", async () => {
    const requests = fakePickMany(env.spies, ["docs"]);
    const result = await t.run(REMOVE, { cwd: env.login, tty: true });
    expect(result.code).toBe(0);
    expect(requests[0]).toMatchObject({
      argument: "repos",
      choices: ["api", "web", "docs"],
    });
    expect(t.recordRepos()).toEqual(["api", "web"]);
  });

  test("not interactive: missing-argument with the record repos, exit 2", async () => {
    const before = t.state();
    const result = await t.json(REMOVE, { cwd: env.login });
    expect(result.code).toBe(2);
    expect(result.data.error.details).toEqual({
      argument: "repos",
      choices: ["api", "web", "docs"],
    });
    expect(t.state()).toEqual(before);
  });

  test("in a codebase folder: the project picker, before the lock", async () => {
    const lockAtPick: boolean[] = [];
    env.spies.push(
      spyOn(promptAdapter, "createPrompt").mockImplementation(() => ({
        pick: () => {
          lockAtPick.push(existsSync(env.lockFile));
          return Promise.resolve("feat--login");
        },
      })),
    );
    const result = await t.run([...REMOVE, "web"], { tty: true });
    expect(result.code).toBe(0);
    expect(lockAtPick).toEqual([false]);
    expect(t.recordRepos()).toEqual(["api", "docs"]);
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
    const result = await t.json([...REMOVE, "web"]);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("project-not-found");
    expect(result.data.error.message).toBe("The project feat--login is gone.");
    expect(existsSync(env.lockFile)).toBe(false);
  });

  test("in a codebase folder, not interactive: missing-argument for the project", async () => {
    const result = await t.json([...REMOVE, "web"]);
    expect(result.code).toBe(2);
    expect(result.data.error.details).toEqual({
      argument: "project",
      choices: ["feat--login"],
    });
  });

  test("Escape in the repo picker: interrupted, exit 130", async () => {
    fakeKeys(env.spies, ["\x1b"]);
    const before = t.state();
    const result = await t.run(REMOVE, { cwd: env.login, tty: true });
    expect(result.code).toBe(130);
    expect(t.state()).toEqual(before);
  });
});

describe("xr project repo remove: delete phase stops", () => {
  test("a failed 2nd worktree remove: stop, the rest are leftovers with commands", async () => {
    t.fakeGit((g) => withFault(g, "worktreeRemove", 2));
    const result = await t.json([...REMOVE, "web", "docs"], { cwd: env.login });
    expect(result.code).toBe(1);
    const docs = join(env.codebase, "docs");
    const file = join(env.login, ".crossrepo", "project.yaml");
    const agents = join(env.login, "AGENTS.md");
    expect(result.data.error.details.leftovers).toEqual([
      {
        what: "worktree of docs",
        path: join(env.login, "docs"),
        command: `git -C "${docs}" worktree remove --force "${join(env.login, "docs")}"`,
      },
      {
        what: "project record",
        path: file,
        command: `Remove web, docs from \`repos:\` in ${file} by hand.`,
      },
      {
        what: "AGENTS.md",
        path: agents,
        command:
          "Remove the web, docs lines from the `## Codebase` and `## Repos` sections of AGENTS.md by hand.",
      },
    ]);
    expect(t.recordRepos()).toEqual(["api", "web", "docs"]);
    expect(existsSync(env.lockFile)).toBe(false);
  });

  test("Ctrl-C after the 1st worktree remove: the rest are leftovers, exit 130", async () => {
    t.fakeGit((g) =>
      afterCall(g, "worktreeRemove", 1, () => env.interrupts.fire()),
    );
    const result = await t.json([...REMOVE, "web", "docs"], { cwd: env.login });
    expect(result.code).toBe(130);
    expect(result.data.error.code).toBe("interrupted");
    expect(
      result.data.error.details.leftovers.map((l: { what: string }) => l.what),
    ).toEqual(["worktree of docs", "project record", "AGENTS.md"]);
    expect(existsSync(join(env.login, "web"))).toBe(false);
    expect(t.recordRepos()).toEqual(["api", "web", "docs"]);
  });
});

describe("xr project repo remove of the current folder", () => {
  test("cwd in a removed worktree: xr moves to the project folder, then a note", async () => {
    const cwd = join(env.login, "web");
    // Discovery never looks at a parent folder, so a worktree needs `--codebase-path`.
    const result = await t.json(
      ["--codebase-path", env.login, ...REMOVE, "web"],
      { cwd },
    );
    expect(result.code).toBe(0);
    expect(env.chdirs).toEqual([env.login]);
    expect(result.data.notes).toEqual([
      `Your shell is in a deleted folder. Run \`cd ${env.login}\`.`,
    ]);
  });

  test("cwd in a worktree that stays: no move", async () => {
    const result = await t.json(
      ["--codebase-path", env.login, ...REMOVE, "web"],
      { cwd: join(env.login, "api") },
    );
    expect(result.code).toBe(0);
    expect(env.chdirs).toEqual([]);
    expect(result.data.notes).toBeUndefined();
  });
});
