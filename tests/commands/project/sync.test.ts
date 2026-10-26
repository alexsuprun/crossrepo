import { describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as gitAdapter from "../../../src/adapters/git/index.ts";
import * as promptAdapter from "../../../src/adapters/prompt/index.ts";
import { GitError } from "../../../src/errors/index.ts";
import { git, pushCommit } from "../../helpers/git.ts";
import { writeFile } from "../../helpers/isolate.ts";
import { useProjectRepoEnv } from "../../helpers/project-repo.ts";

const t = useProjectRepoEnv();
const { env } = t;
const SYNC = ["project", "sync"];
const RUN_HINT =
  "Fix each failed or conflicted repo, then run `xr project sync` again.";

/** The worktree of `repo` in the project `feat--login`. */
const wt = (repo: string) => join(env.login, repo);
const origin = (repo: string) => env.remotes[repo] as string;
const head = (dir: string) => git(dir, "rev-parse", "HEAD").trim();
const branchOf = (dir: string) => git(dir, "branch", "--show-current").trim();

/** Adds `web` and `docs` to the project, so it has api, web, docs in record order. */
async function allRepos() {
  const added = await t.run(["project", "repo", "add", "web", "docs"], {
    cwd: env.login,
  });
  if (added.code !== 0) throw new Error(added.stderr);
}

function commitIn(dir: string, file: string, text: string) {
  writeFileSync(join(dir, file), text);
  git(dir, "add", "--", file);
  git(dir, "commit", "--quiet", "-m", `local ${file}`);
}

/** Pushes a commit to origin that changes `file`, and makes a local commit that changes it too. */
function conflictIn(repo: string, ...files: string[]) {
  for (const file of files) {
    pushCommit(origin(repo), { file });
    commitIn(wt(repo), file, "local\n");
  }
}

/** Counts the `fetch` and `mergeAutostash` calls, and keeps the ref of each merge. */
function countGit() {
  const calls = {
    fetch: 0,
    merge: 0,
    mergeRefs: [] as string[],
  };
  t.fakeGit((g) => ({
    ...g,
    fetch(...args) {
      calls.fetch += 1;
      return g.fetch(...args);
    },
    mergeAutostash(dir, ref) {
      calls.merge += 1;
      calls.mergeRefs.push(ref);
      return g.mergeAutostash(dir, ref);
    },
  }));
  return calls;
}

/** Fires one Ctrl-C at the first output of the `nth` fetch, so the signal stops a live git. */
function interruptFetch(nth: number) {
  const real = gitAdapter.createGit;
  let fetches = 0;
  let fired = false;
  env.spies.push(
    spyOn(gitAdapter, "createGit").mockImplementation((options) => {
      const inner = real({
        ...options,
        stderr(text) {
          options.stderr?.(text);
          if (fired || fetches !== nth) return;
          fired = true;
          env.interrupts.fire();
        },
      });
      return {
        ...inner,
        fetch(...args) {
          fetches += 1;
          return inner.fetch(...args);
        },
      };
    }),
  );
}

const ok = (repo: string, message = "up to date") => ({
  repo,
  status: "ok",
  message,
});
const stopped = (repo: string) => ({
  repo,
  status: "skipped",
  message: "interrupted",
});

describe("xr project sync: the project", () => {
  test("in a project folder with no argument: syncs that project", async () => {
    const result = await t.json(SYNC, { cwd: env.login });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      `${JSON.stringify({
        ok: true,
        warnings: [],
        project: env.login,
        branch: "feat/login",
        repos: [ok("api")],
      })}\n`,
    );
    expect(existsSync(env.lockFile)).toBe(false);
  });

  test("in a codebase folder by name: syncs the named project", async () => {
    pushCommit(origin("api"));
    const result = await t.json([...SYNC, "feat--login"]);
    expect(result.code).toBe(0);
    expect(result.data.repos).toEqual([
      ok("api", "fast-forwarded to origin/main"),
    ]);
  });

  test("by branch works too", async () => {
    const result = await t.json([...SYNC, "feat/login"]);
    expect(result.code).toBe(0);
    expect(result.data.project).toBe(env.login);
  });

  test("an unknown name: project-not-found", async () => {
    const result = await t.json([...SYNC, "nope"]);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("project-not-found");
  });

  test("in a codebase folder with no argument, in a terminal: the picker before the lock", async () => {
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
    const calls = countGit();
    const result = await t.run(SYNC, { tty: true });
    expect(result.code).toBe(0);
    expect(lockAtPick).toEqual([false]);
    expect(requests[0]).toMatchObject({
      argument: "project",
      choices: ["feat--login"],
      hints: { "feat--login": "feat/login" },
    });
    expect(calls.fetch).toBe(1);
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
    const result = await t.json(SYNC);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("project-not-found");
    expect(existsSync(env.lockFile)).toBe(false);
  });

  test("in a codebase folder with no argument, not interactive: missing-argument, exit 2, nothing runs", async () => {
    const calls = countGit();
    const result = await t.json(SYNC);
    expect(result.code).toBe(2);
    expect(result.data.error.code).toBe("missing-argument");
    expect(result.data.error.details).toEqual({
      argument: "project",
      choices: ["feat--login"],
    });
    expect(calls.fetch).toBe(0);
  });

  test("outside a codebase: not-a-codebase", async () => {
    const result = await t.json(SYNC, { cwd: env.iso.root });
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("not-a-codebase");
  });

  test("runs no hook", async () => {
    const out = join(env.iso.root, "hook.txt");
    writeFile(
      env.configFile,
      `${t.configText()}project:\n  post-create:\n    - ${JSON.stringify(`touch "${out}"`)}\n`,
    );
    const result = await t.json(SYNC, { cwd: env.login });
    expect(result.code).toBe(0);
    expect(existsSync(out)).toBe(false);
  });
});

describe("xr project sync: the merge", () => {
  test("origin ahead, no local commits: fast-forward, still on the project branch", async () => {
    const target = pushCommit(origin("api"), { file: "new.txt" });
    const result = await t.json(SYNC, { cwd: env.login });
    expect(result.code).toBe(0);
    expect(result.data.repos).toEqual([
      ok("api", "fast-forwarded to origin/main"),
    ]);
    expect(head(wt("api"))).toBe(target);
    expect(branchOf(wt("api"))).toBe("feat/login");
  });

  test("both sides have commits: one merge commit, the only new commit", async () => {
    const theirs = pushCommit(origin("api"), { file: "theirs.txt" });
    commitIn(wt("api"), "mine.txt", "mine\n");
    const mine = head(wt("api"));
    const result = await t.json(SYNC, { cwd: env.login });
    expect(result.code).toBe(0);
    expect(result.data.repos).toEqual([ok("api", "merged origin/main")]);
    expect(git(wt("api"), "rev-parse", "HEAD^1").trim()).toBe(mine);
    expect(git(wt("api"), "rev-parse", "HEAD^2").trim()).toBe(theirs);
    expect(
      git(
        wt("api"),
        "rev-list",
        "--count",
        `${mine}..HEAD`,
        `^${theirs}`,
      ).trim(),
    ).toBe("1");
    expect(branchOf(wt("api"))).toBe("feat/login");
  });

  test("an uncommitted change in another file is still there after the merge", async () => {
    pushCommit(origin("api"), { file: "theirs.txt" });
    writeFileSync(join(wt("api"), "mine.txt"), "draft\n");
    git(wt("api"), "add", "--", "mine.txt");
    writeFileSync(join(wt("api"), "mine.txt"), "draft 2\n");
    const result = await t.json(SYNC, { cwd: env.login });
    expect(result.code).toBe(0);
    expect(result.data.repos).toEqual([
      ok("api", "fast-forwarded to origin/main"),
    ]);
    expect(readFileSync(join(wt("api"), "mine.txt"), "utf8")).toBe("draft 2\n");
    expect(git(wt("api"), "stash", "list")).toBe("");
  });

  test("a conflict: files and the merge hint, the other repos still synced, repos-failed exit 1", async () => {
    await allRepos();
    conflictIn("api", "a.txt", "b.txt");
    const target = pushCommit(origin("web"), { file: "new.txt" });
    const result = await t.json(SYNC, { cwd: env.login });
    expect(result.code).toBe(1);
    const path = wt("api");
    expect(result.data).toEqual({
      ok: false,
      warnings: [],
      project: env.login,
      branch: "feat/login",
      repos: [
        {
          repo: "api",
          status: "conflict",
          message: "merge conflict in 2 files: `a.txt`, `b.txt`",
          hint: `Fix the files, then run \`git -C "${path}" merge --continue\`, or run \`git -C "${path}" merge --abort\`.`,
          files: ["a.txt", "b.txt"],
        },
        ok("web", "fast-forwarded to origin/main"),
        ok("docs"),
      ],
      error: {
        code: "repos-failed",
        message: "1 of 3 repos has conflicts: api.",
        hint: RUN_HINT,
      },
    });
    // The conflict stays for the user (D35).
    expect(git(path, "rev-parse", "-q", "--verify", "MERGE_HEAD")).not.toBe("");
    expect(head(wt("web"))).toBe(target);
    expect(existsSync(env.lockFile)).toBe(false);
  });

  test("a conflict in more than 5 files names 5, then the count of the rest", async () => {
    conflictIn(
      "api",
      "1.txt",
      "2.txt",
      "3.txt",
      "4.txt",
      "5.txt",
      "6.txt",
      "7.txt",
    );
    const result = await t.json(SYNC, { cwd: env.login });
    expect(result.code).toBe(1);
    const [item] = result.data.repos;
    expect(item.message).toBe(
      "merge conflict in 7 files: `1.txt`, `2.txt`, `3.txt`, `4.txt`, `5.txt` and 2 more",
    );
    expect(item.files).toHaveLength(7);
  });

  test("text shows a conflict with !, the hint under it, and the error", async () => {
    conflictIn("api", "a.txt");
    const result = await t.run(SYNC, { cwd: env.login });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("! api: merge conflict in 1 file: `a.txt`");
    expect(result.stderr).toContain("error: 1 of 1 repo has conflicts: api.");
    expect(result.stderr).toContain(RUN_HINT);
  });

  /** Leaves `api` with a kept autostash and `f.txt` unmerged, as a sync of a conflicting uncommitted change does. */
  async function stashConflict() {
    pushCommit(origin("api"), { file: "f.txt" });
    git(wt("api"), "fetch", "--quiet", "origin");
    git(wt("api"), "merge", "--quiet", "--ff-only", "origin/main");
    const target = pushCommit(origin("api"), { file: "f.txt" });
    writeFileSync(join(wt("api"), "f.txt"), "mine\n");
    return { target, result: await t.json(SYNC, { cwd: env.login }) };
  }

  test("the merge passes but the uncommitted change conflicts with it: stashKept, files, and the reset and stash drop hint", async () => {
    const { target, result } = await stashConflict();
    expect(result.code).toBe(1);
    const path = wt("api");
    expect(result.data.repos).toEqual([
      {
        repo: "api",
        status: "conflict",
        message:
          "merged origin/main, but your changes conflict with it: they stay in `git stash list`",
        hint: `Fix the files, then run \`git -C "${path}" reset\` and \`git -C "${path}" stash drop\`.`,
        files: ["f.txt"],
        stashKept: true,
      },
    ]);
    expect(result.data.error.code).toBe("repos-failed");
    expect(head(path)).toBe(target);
    expect(git(path, "stash", "list")).toContain("autostash");
  });

  test("a later sync of that repo: failed unmerged files with the reset hint, no fetch, no merge; the others go on", async () => {
    await allRepos();
    await stashConflict();
    const calls = countGit();
    const result = await t.json(SYNC, { cwd: env.login });
    expect(result.code).toBe(1);
    const path = wt("api");
    expect(result.data.repos).toEqual([
      {
        repo: "api",
        status: "failed",
        message: "unmerged files: `f.txt`",
        hint: `Fix the files, then run \`git -C "${path}" reset\`; if \`git stash list\` has the \`autostash\` entry of sync, run \`git -C "${path}" stash drop\`.`,
        files: ["f.txt"],
      },
      ok("web"),
      ok("docs"),
    ]);
    expect(calls).toMatchObject({ fetch: 2, merge: 2 });
  });

  test("a merge that fails for another reason, such as no user identity: failed with the git message; the others go on", async () => {
    await allRepos();
    pushCommit(origin("api"), { file: "theirs.txt" });
    commitIn(wt("api"), "mine.txt", "mine\n");
    t.fakeGit((g) => ({
      ...g,
      async mergeAutostash(dir, ref) {
        if (dir === wt("api")) {
          throw new GitError({
            args: ["merge"],
            exitCode: 128,
            stderr:
              "Committer identity unknown\n\nfatal: no email was given and auto-detection is disabled\n",
          });
        }
        return g.mergeAutostash(dir, ref);
      },
    }));
    const result = await t.json(SYNC, { cwd: env.login });
    expect(result.code).toBe(1);
    expect(result.data.repos).toEqual([
      {
        repo: "api",
        status: "failed",
        message: "fatal: no email was given and auto-detection is disabled",
      },
      ok("web"),
      ok("docs"),
    ]);
    expect(result.data.error.code).toBe("repos-failed");
  });

  test("the merge gets the full remote ref, so a local branch named origin/main does not confuse it", async () => {
    const target = pushCommit(origin("api"));
    git(wt("api"), "branch", "origin/main", "HEAD");
    const calls = countGit();
    const result = await t.json(SYNC, { cwd: env.login });
    expect(result.code).toBe(0);
    expect(result.data.repos).toEqual([
      ok("api", "fast-forwarded to origin/main"),
    ]);
    expect(calls.mergeRefs).toEqual(["refs/remotes/origin/main"]);
    expect(head(wt("api"))).toBe(target);
  });
});

describe("xr project sync: checks before any git write", () => {
  test("a missing worktree folder fails that repo with the doctor hint; the others go on", async () => {
    await allRepos();
    rmSync(wt("web"), { recursive: true, force: true });
    const target = pushCommit(origin("docs"));
    const result = await t.json(SYNC, { cwd: env.login });
    expect(result.code).toBe(1);
    expect(result.data.repos).toEqual([
      ok("api"),
      {
        repo: "web",
        status: "failed",
        message: "worktree folder missing",
        hint: "xr project doctor",
      },
      ok("docs", "fast-forwarded to origin/main"),
    ]);
    expect(result.data.error.message).toBe("1 of 3 repos failed: web.");
    expect(head(wt("docs"))).toBe(target);
  });

  test("another branch: failed with the switch hint, no fetch, no merge", async () => {
    git(wt("api"), "switch", "--quiet", "-c", "other");
    pushCommit(origin("api"));
    const before = head(wt("api"));
    const calls = countGit();
    const result = await t.json(SYNC, { cwd: env.login });
    expect(result.code).toBe(1);
    expect(result.data.repos).toEqual([
      {
        repo: "api",
        status: "failed",
        message: "on branch `other`, not `feat/login`",
        hint: `Run \`git -C "${wt("api")}" switch feat/login\`.`,
      },
    ]);
    expect(calls).toMatchObject({ fetch: 0, merge: 0 });
    expect(head(wt("api"))).toBe(before);
    expect(branchOf(wt("api"))).toBe("other");
  });

  test("a detached HEAD: failed with the switch hint, no fetch", async () => {
    git(wt("api"), "switch", "--quiet", "--detach");
    const calls = countGit();
    const result = await t.json(SYNC, { cwd: env.login });
    expect(result.code).toBe(1);
    expect(result.data.repos).toEqual([
      {
        repo: "api",
        status: "failed",
        message: "detached HEAD",
        hint: `Run \`git -C "${wt("api")}" switch feat/login\`.`,
      },
    ]);
    expect(calls.fetch).toBe(0);
  });

  test("a merge in progress: failed with the continue and abort hint, no fetch", async () => {
    conflictIn("api", "a.txt");
    git(wt("api"), "fetch", "--quiet", "origin");
    const merge = spawnSync("git", ["merge", "--no-edit", "origin/main"], {
      cwd: wt("api"),
      env: { ...process.env },
    });
    expect(merge.status).toBe(1);
    const calls = countGit();
    const result = await t.json(SYNC, { cwd: env.login });
    expect(result.code).toBe(1);
    const path = wt("api");
    expect(result.data.repos).toEqual([
      {
        repo: "api",
        status: "failed",
        message: "merge in progress",
        hint: `Run \`git -C "${path}" merge --continue\` or \`git -C "${path}" merge --abort\`.`,
      },
    ]);
    expect(calls.fetch).toBe(0);
  });

  test("no default branch: failed with the no-default-branch message and the set-head hint", async () => {
    await allRepos();
    writeFile(
      env.configFile,
      t
        .configText()
        .replace(/( {2}web:\n.*\n) {4}default-branch: main\n/, "$1"),
    );
    git(join(env.codebase, "web"), "remote", "set-head", "origin", "--delete");
    const calls = countGit();
    const result = await t.json(SYNC, { cwd: env.login });
    expect(result.code).toBe(1);
    const dir = join(env.codebase, "web");
    expect(result.data.repos).toEqual([
      ok("api"),
      {
        repo: "web",
        status: "failed",
        message:
          "`web` has no default branch: the config has no `default-branch` for it, and `origin/HEAD` is not set.",
        hint: `Run \`git -C "${dir}" remote set-head origin --auto\`, or set \`default-branch\` of \`web\` in the config, then run the command again.`,
      },
      ok("docs"),
    ]);
    expect(calls.fetch).toBe(2);
  });

  test("origin/HEAD is used when the config has no default-branch", async () => {
    writeFile(
      env.configFile,
      t
        .configText()
        .replace(/( {2}api:\n.*\n) {4}default-branch: main\n/, "$1"),
    );
    pushCommit(origin("api"));
    const result = await t.json(SYNC, { cwd: env.login });
    expect(result.code).toBe(0);
    expect(result.data.repos).toEqual([
      ok("api", "fast-forwarded to origin/main"),
    ]);
  });

  test("a failed fetch fails only that repo, with the git message; the others go on", async () => {
    await allRepos();
    git(
      wt("api"),
      "remote",
      "set-url",
      "origin",
      join(env.iso.root, "gone.git"),
    );
    const target = pushCommit(origin("web"));
    const calls = countGit();
    const result = await t.json(SYNC, { cwd: env.login });
    expect(result.code).toBe(1);
    const [api, web, docs] = result.data.repos;
    expect(api.status).toBe("failed");
    expect(api.message).toMatch(/^fatal: /);
    expect(web).toEqual(ok("web", "fast-forwarded to origin/main"));
    expect(docs).toEqual(ok("docs"));
    expect(calls.merge).toBe(2);
    expect(head(wt("web"))).toBe(target);
    expect(result.data.error.message).toBe("1 of 3 repos failed: api.");
  });
});

describe("xr project sync: Ctrl-C", () => {
  test("Ctrl-C while a fetch streams: that repo and the later ones are interrupted, exit 130, lock released", async () => {
    await allRepos();
    pushCommit(origin("web"));
    interruptFetch(2);
    const webBefore = head(wt("web"));
    const result = await t.json(SYNC, { cwd: env.login });
    expect(result.code).toBe(130);
    expect(result.data.error.code).toBe("interrupted");
    expect(result.data.repos).toEqual([
      ok("api"),
      stopped("web"),
      stopped("docs"),
    ]);
    expect(head(wt("web"))).toBe(webBefore);
    expect(existsSync(env.lockFile)).toBe(false);
  });

  test("a merge in flight is not stopped: it keeps its result, the later repos are interrupted", async () => {
    await allRepos();
    const target = pushCommit(origin("api"));
    const calls = { mergeArgs: [] as number[] };
    t.fakeGit((g) => ({
      ...g,
      mergeAutostash(...args: [string, string]) {
        calls.mergeArgs.push(args.length);
        env.interrupts.fire();
        return g.mergeAutostash(...args);
      },
    }));
    const result = await t.json(SYNC, { cwd: env.login });
    expect(result.code).toBe(130);
    expect(result.data.repos).toEqual([
      ok("api", "fast-forwarded to origin/main"),
      stopped("web"),
      stopped("docs"),
    ]);
    expect(head(wt("api"))).toBe(target);
    // The merge never gets the Ctrl-C signal: only the dir and the ref.
    expect(calls.mergeArgs).toEqual([2]);
    expect(existsSync(env.lockFile)).toBe(false);
  });
});
