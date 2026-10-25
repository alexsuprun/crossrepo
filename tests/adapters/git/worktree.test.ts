import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { createGit } from "../../../src/adapters/git/index.ts";
import { GitError } from "../../../src/errors/index.ts";
import { git, makeRepos, pushCommit } from "../../helpers/git.ts";
import { type Isolation, isolate } from "../../helpers/isolate.ts";

let iso: Isolation;
let root: string;
let repo: string;
let origin: string;

beforeEach(() => {
  iso = isolate();
  root = join(iso.root, "shop");
  mkdirSync(root);
  origin = makeRepos(root, { api: {} }).api as string;
  repo = join(root, "api");
});

afterEach(() => {
  iso.restore();
});

const adapter = (stderr?: (text: string) => void) =>
  createGit({ interactive: false, env: { ...process.env }, stderr });

function upstreamOf(dir: string, branch: string): string | undefined {
  try {
    return git(dir, "rev-parse", "--abbrev-ref", `${branch}@{upstream}`).trim();
  } catch {
    return undefined;
  }
}

describe("createGit fetch", () => {
  test("fetches origin and streams git output to stderr", async () => {
    pushCommit(origin, { branch: "main" });
    let streamed = "";
    await adapter((text) => {
      streamed += text;
    }).fetch(repo);
    expect(git(repo, "rev-parse", "origin/main").trim()).toBe(
      git(origin, "rev-parse", "main").trim(),
    );
    expect(streamed).toMatch(/main +-> origin\/main/);
  });

  test("an origin that is gone is a GitError", async () => {
    git(repo, "remote", "set-url", "origin", join(iso.root, "nowhere.git"));
    const error = await adapter(() => {})
      .fetch(repo)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).message).toContain("fetch");
  });
});

describe("createGit branches", () => {
  test("localBranchExists and remoteBranchExists", async () => {
    git(repo, "branch", "feat/local");
    git(repo, "push", "--quiet", "origin", "main:feat/remote");
    const g = adapter();
    expect(await g.localBranchExists(repo, "feat/local")).toBe(true);
    expect(await g.localBranchExists(repo, "feat/remote")).toBe(false);
    expect(await g.remoteBranchExists(repo, "feat/remote")).toBe(true);
    expect(await g.remoteBranchExists(repo, "feat/local")).toBe(false);
  });

  test("branchDelete deletes a branch; force deletes an unmerged one", async () => {
    git(repo, "branch", "done");
    git(repo, "checkout", "--quiet", "-b", "unmerged");
    git(repo, "commit", "--quiet", "--allow-empty", "-m", "more");
    git(repo, "checkout", "--quiet", "main");
    const g = adapter();
    await g.branchDelete(repo, "done", { force: false });
    expect(await g.localBranchExists(repo, "done")).toBe(false);
    expect(
      await g
        .branchDelete(repo, "unmerged", { force: false })
        .catch((thrown: unknown) => thrown),
    ).toBeInstanceOf(GitError);
    await g.branchDelete(repo, "unmerged", { force: true });
    expect(await g.localBranchExists(repo, "unmerged")).toBe(false);
  });
});

describe("createGit worktrees", () => {
  test("worktreeList gives each worktree path and its branch", async () => {
    const wt = join(iso.root, "wt");
    git(repo, "worktree", "add", "--quiet", "-b", "feat/x", wt);
    git(repo, "worktree", "add", "--quiet", "--detach", join(iso.root, "det"));
    const list = await adapter().worktreeList(repo);
    // git lists the main worktree first, then the others sorted by path.
    expect(list.map((w) => [basename(w.path), w.branch])).toEqual([
      ["api", "main"],
      ["det", undefined],
      ["wt", "feat/x"],
    ]);
    expect(
      list.every((w) => isAbsolute(w.path) && w.path === resolve(w.path)),
    ).toBe(true);
  });

  test("worktreeAdd local: checks out the existing branch", async () => {
    git(repo, "branch", "feat/x");
    const path = join(iso.root, "p", "api");
    mkdirSync(join(iso.root, "p"));
    await adapter().worktreeAdd(repo, path, {
      branch: "feat/x",
      source: "local",
    });
    expect(git(path, "branch", "--show-current").trim()).toBe("feat/x");
  });

  test("worktreeAdd tracking: a new branch that tracks origin/<branch>", async () => {
    git(repo, "push", "--quiet", "origin", "main:feat/x");
    git(repo, "fetch", "--quiet", "origin");
    const path = join(iso.root, "api-x");
    await adapter().worktreeAdd(repo, path, {
      branch: "feat/x",
      source: "tracking",
      startPoint: "origin/feat/x",
    });
    expect(git(path, "branch", "--show-current").trim()).toBe("feat/x");
    expect(upstreamOf(path, "feat/x")).toBe("origin/feat/x");
  });

  test("worktreeAdd new: a new branch from the default branch with no upstream", async () => {
    const path = join(iso.root, "api-x");
    await adapter().worktreeAdd(repo, path, {
      branch: "feat/x",
      source: "new",
      startPoint: "origin/main",
    });
    expect(git(path, "branch", "--show-current").trim()).toBe("feat/x");
    expect(upstreamOf(path, "feat/x")).toBeUndefined();
  });

  test("worktreeAdd of a branch checked out elsewhere is a GitError", async () => {
    const error = await adapter()
      .worktreeAdd(repo, join(iso.root, "x"), {
        branch: "main",
        source: "local",
      })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GitError);
  });

  test("worktreeRemove removes a worktree with changes; worktreePrune drops a deleted one", async () => {
    const g = adapter();
    const a = join(iso.root, "a");
    const b = join(iso.root, "b");
    git(repo, "worktree", "add", "--quiet", "-b", "a", a);
    git(repo, "worktree", "add", "--quiet", "-b", "b", b);
    await Bun.write(join(a, "new.txt"), "x");
    await g.worktreeRemove(repo, a);
    expect(existsSync(a)).toBe(false);
    rmSync(b, { recursive: true });
    await g.worktreePrune(repo);
    expect((await g.worktreeList(repo)).map((w) => w.branch)).toEqual(["main"]);
  });
});

describe("createGit uncommittedFiles", () => {
  test("a clean worktree has none", async () => {
    const path = join(iso.root, "w");
    git(repo, "worktree", "add", "--quiet", "-b", "feat/x", path);
    expect(await adapter().uncommittedFiles(path)).toEqual([]);
  });

  test("changed, staged and untracked files count; ignored files do not", async () => {
    const path = join(iso.root, "w");
    await Bun.write(join(repo, "tracked.txt"), "1\n");
    await Bun.write(join(repo, ".gitignore"), "*.log\n");
    git(repo, "add", "tracked.txt", ".gitignore");
    git(repo, "commit", "--quiet", "-m", "files");
    git(repo, "worktree", "add", "--quiet", "-b", "feat/x", path);
    await Bun.write(join(path, "tracked.txt"), "2\n");
    await Bun.write(join(path, "staged.txt"), "s\n");
    git(path, "add", "staged.txt");
    await Bun.write(join(path, "sub", "new.txt"), "n\n");
    await Bun.write(join(path, "debug.log"), "ignored\n");
    expect((await adapter().uncommittedFiles(path)).sort()).toEqual([
      "staged.txt",
      "sub/new.txt",
      "tracked.txt",
    ]);
  });

  test("unpushed commits and stashes do not count", async () => {
    const path = join(iso.root, "w");
    git(repo, "worktree", "add", "--quiet", "-b", "feat/x", path);
    git(path, "commit", "--quiet", "--allow-empty", "-m", "local only");
    await Bun.write(join(path, "s.txt"), "s\n");
    git(path, "add", "s.txt");
    git(path, "stash", "--quiet");
    expect(await adapter().uncommittedFiles(path)).toEqual([]);
  });

  test("only the given worktree counts, not the main one", async () => {
    const path = join(iso.root, "w");
    git(repo, "worktree", "add", "--quiet", "-b", "feat/x", path);
    await Bun.write(join(repo, "main-only.txt"), "m\n");
    expect(await adapter().uncommittedFiles(path)).toEqual([]);
    expect(await adapter().uncommittedFiles(repo)).toEqual(["main-only.txt"]);
  });

  test("a folder that is not a repo is a GitError", async () => {
    const error = await adapter()
      .uncommittedFiles(iso.root)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GitError);
  });
});
