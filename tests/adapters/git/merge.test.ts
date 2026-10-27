import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createGit } from "../../../src/adapters/git/index.ts";
import { GitError } from "../../../src/errors/index.ts";
import { git, makeRepos, pushCommit } from "../../helpers/git.ts";
import { type Isolation, isolate } from "../../helpers/isolate.ts";

let iso: Isolation;
let repo: string;
let origin: string;

beforeEach(() => {
  iso = isolate();
  const root = join(iso.root, "shop");
  mkdirSync(root);
  origin = makeRepos(root, { api: {} }).api as string;
  repo = join(root, "api");
  writeFileSync(join(repo, "f.txt"), "base\n");
  git(repo, "add", "--", "f.txt");
  git(repo, "commit", "--quiet", "-m", "base");
  git(repo, "push", "--quiet", "origin", "main");
});

afterEach(() => {
  iso.restore();
});

const adapter = (env: Record<string, string | undefined> = process.env) =>
  createGit({ interactive: false, env: { ...env }, stderr: () => {} });

const head = () => git(repo, "rev-parse", "HEAD").trim();
const parents = () =>
  git(repo, "rev-list", "--parents", "-n", "1", "HEAD").trim().split(" ")
    .length - 1;

function commitLocal(file: string, text: string) {
  writeFileSync(join(repo, file), text);
  git(repo, "add", "--", file);
  git(repo, "commit", "--quiet", "-m", `local ${file}`);
}

describe("createGit currentBranch", () => {
  test("gives the checked-out branch", async () => {
    expect(await adapter().currentBranch(repo)).toBe("main");
    git(repo, "switch", "--quiet", "-c", "feat/login");
    expect(await adapter().currentBranch(repo)).toBe("feat/login");
  });

  test("a tag with the same name as the branch does not change the name", async () => {
    git(repo, "switch", "--quiet", "-c", "feat");
    git(repo, "tag", "feat");
    expect(await adapter().currentBranch(repo)).toBe("feat");
  });

  test("a detached HEAD gives undefined", async () => {
    git(repo, "switch", "--quiet", "--detach");
    expect(await adapter().currentBranch(repo)).toBeUndefined();
  });
});

describe("createGit mergeInProgress", () => {
  test("false with no MERGE_HEAD, true while a merge waits", async () => {
    const g = adapter();
    expect(await g.mergeInProgress(repo)).toBe(false);
    pushCommit(origin, { file: "f.txt" });
    commitLocal("f.txt", "local\n");
    git(repo, "fetch", "--quiet", "origin");
    const merge = spawnSync("git", ["merge", "--no-edit", "origin/main"], {
      cwd: repo,
      env: { ...process.env },
    });
    expect(merge.status).toBe(1);
    expect(await g.mergeInProgress(repo)).toBe(true);
  });
});

describe("createGit unmergedFiles", () => {
  test("none in a clean worktree; the unmerged files after a conflict", async () => {
    const g = adapter();
    expect(await g.unmergedFiles(repo)).toEqual([]);
    pushCommit(origin, { file: "f.txt" });
    commitLocal("f.txt", "local\n");
    git(repo, "fetch", "--quiet", "origin");
    spawnSync("git", ["merge", "--no-edit", "origin/main"], {
      cwd: repo,
      env: { ...process.env },
    });
    expect(await g.unmergedFiles(repo)).toEqual(["f.txt"]);
  });
});

describe("createGit mergeAutostash", () => {
  test("nothing new on origin: up-to-date, HEAD stays", async () => {
    git(repo, "fetch", "--quiet", "origin");
    const before = head();
    expect(await adapter().mergeAutostash(repo, "origin/main")).toEqual({
      result: "up-to-date",
      stashKept: false,
    });
    expect(head()).toBe(before);
  });

  test("origin ahead and no local commits: merged with fastForward", async () => {
    const target = pushCommit(origin, { file: "new.txt" });
    git(repo, "fetch", "--quiet", "origin");
    expect(await adapter().mergeAutostash(repo, "origin/main")).toEqual({
      result: "merged",
      fastForward: true,
      stashKept: false,
    });
    expect(head()).toBe(target);
  });

  test("a fast-forward onto an origin tip that is a merge commit is still fastForward", async () => {
    const work = join(iso.root, "work");
    git(iso.root, "clone", "--quiet", origin, work);
    git(work, "switch", "--quiet", "-c", "side");
    git(work, "commit", "--quiet", "--allow-empty", "-m", "side");
    git(work, "switch", "--quiet", "main");
    git(work, "merge", "--quiet", "--no-ff", "--no-edit", "side");
    git(work, "push", "--quiet", "origin", "main");
    git(repo, "fetch", "--quiet", "origin");
    expect(await adapter().mergeAutostash(repo, "origin/main")).toEqual({
      result: "merged",
      fastForward: true,
      stashKept: false,
    });
    expect(head()).toBe(git(repo, "rev-parse", "origin/main").trim());
  });

  test.skipIf(process.platform === "win32")(
    "a failed merge with MERGE_HEAD but no unmerged files, such as a failing pre-merge-commit hook, is a GitError",
    async () => {
      pushCommit(origin, { file: "theirs.txt" });
      commitLocal("mine.txt", "mine\n");
      git(repo, "fetch", "--quiet", "origin");
      const hook = join(repo, ".git", "hooks", "pre-merge-commit");
      writeFileSync(hook, "#!/bin/sh\necho no >&2\nexit 1\n");
      chmodSync(hook, 0o755);
      const error = await adapter()
        .mergeAutostash(repo, "origin/main")
        .catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(GitError);
    },
  );

  test("both sides have commits: a merge commit, with no editor", async () => {
    const theirs = pushCommit(origin, { file: "theirs.txt" });
    commitLocal("mine.txt", "mine\n");
    const mine = head();
    git(repo, "fetch", "--quiet", "origin");
    expect(await adapter().mergeAutostash(repo, "origin/main")).toEqual({
      result: "merged",
      fastForward: false,
      stashKept: false,
    });
    expect(parents()).toBe(2);
    expect(git(repo, "rev-parse", "HEAD^1").trim()).toBe(mine);
    expect(git(repo, "rev-parse", "HEAD^2").trim()).toBe(theirs);
  });

  test("uncommitted changes in another file survive the merge", async () => {
    pushCommit(origin, { file: "theirs.txt" });
    writeFileSync(join(repo, "f.txt"), "base\nmine\n");
    git(repo, "fetch", "--quiet", "origin");
    expect(await adapter().mergeAutostash(repo, "origin/main")).toEqual({
      result: "merged",
      fastForward: true,
      stashKept: false,
    });
    expect(readFileSync(join(repo, "f.txt"), "utf8")).toBe("base\nmine\n");
    expect(git(repo, "stash", "list")).toBe("");
  });

  test("same lines changed on both sides: conflict with the files; the merge stays for the user", async () => {
    pushCommit(origin, { file: "f.txt" });
    pushCommit(origin, { file: "g.txt" });
    commitLocal("f.txt", "local\n");
    commitLocal("g.txt", "local\n");
    git(repo, "fetch", "--quiet", "origin");
    const g = adapter();
    expect(await g.mergeAutostash(repo, "origin/main")).toEqual({
      result: "conflict",
      files: ["f.txt", "g.txt"],
      stashKept: false,
    });
    expect(await g.mergeInProgress(repo)).toBe(true);
    expect(git(repo, "stash", "list")).toBe("");
  });

  test("the merge passes but the uncommitted changes conflict: stashKept, entry in the stash list", async () => {
    const target = pushCommit(origin, { file: "f.txt" });
    writeFileSync(join(repo, "f.txt"), "mine\n");
    git(repo, "fetch", "--quiet", "origin");
    expect(await adapter().mergeAutostash(repo, "origin/main")).toEqual({
      result: "merged",
      fastForward: true,
      stashKept: true,
    });
    expect(head()).toBe(target);
    expect(git(repo, "stash", "list")).toContain("autostash");
  });

  test("an older stash does not count as kept", async () => {
    writeFileSync(join(repo, "f.txt"), "old work\n");
    git(repo, "stash", "push", "--quiet");
    pushCommit(origin, { file: "new.txt" });
    git(repo, "fetch", "--quiet", "origin");
    expect(await adapter().mergeAutostash(repo, "origin/main")).toEqual({
      result: "merged",
      fastForward: true,
      stashKept: false,
    });
  });

  test.skipIf(process.platform === "win32")(
    "git merge runs in its own process group, so a terminal Ctrl-C never reaches it",
    async () => {
      pushCommit(origin, { file: "theirs.txt" });
      commitLocal("mine.txt", "mine\n");
      git(repo, "fetch", "--quiet", "origin");
      const out = join(iso.root, "pgid.txt");
      const hook = join(repo, ".git", "hooks", "pre-merge-commit");
      writeFileSync(hook, `#!/bin/sh\nps -o pgid= -p $$ > "${out}"\n`);
      chmodSync(hook, 0o755);
      await adapter().mergeAutostash(repo, "origin/main");
      const ours = spawnSync("ps", ["-o", "pgid=", "-p", String(process.pid)], {
        encoding: "utf8",
      }).stdout.trim();
      const merge = readFileSync(out, "utf8").trim();
      expect(merge).not.toBe("");
      expect(merge).not.toBe(ours);
    },
  );

  test("any other failure is a GitError, such as no user identity", async () => {
    pushCommit(origin, { file: "theirs.txt" });
    commitLocal("mine.txt", "mine\n");
    git(repo, "fetch", "--quiet", "origin");
    // An empty HOME has no .gitconfig, so the global config has no identity.
    const empty = join(iso.root, "empty-home");
    mkdirSync(empty);
    git(repo, "config", "user.useConfigOnly", "true");
    const error = await adapter({
      ...process.env,
      HOME: empty,
      USERPROFILE: empty,
      XDG_CONFIG_HOME: empty,
      EMAIL: undefined,
      GIT_AUTHOR_NAME: undefined,
      GIT_AUTHOR_EMAIL: undefined,
      GIT_COMMITTER_NAME: undefined,
      GIT_COMMITTER_EMAIL: undefined,
    })
      .mergeAutostash(repo, "origin/main")
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).args).toContain("merge");
  });
});

describe("createGit write methods (NFR9)", () => {
  test("has no commit, add, stash or rebase method: mergeAutostash is the only one that commits", () => {
    const names = Object.keys(adapter());
    expect(names).toContain("mergeAutostash");
    expect(
      names.filter((name) => /^(commit|add|stash|rebase)/i.test(name)),
    ).toEqual([]);
  });
});
