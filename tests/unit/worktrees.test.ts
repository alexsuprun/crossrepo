import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createFs } from "../../src/adapters/fs/index.ts";
import { createGit } from "../../src/adapters/git/index.ts";
import { createLock } from "../../src/adapters/lock/index.ts";
import type { Ctx, Leftover, Tx } from "../../src/domain/ctx.ts";
import type { XrError } from "../../src/errors/index.ts";
import { transaction } from "../../src/runners/transaction.ts";
import {
  makeProjectFolderStep,
  writeProjectRecordStep,
} from "../../src/services/projects.ts";
import { addWorktreeStep, chooseBranch } from "../../src/services/worktrees.ts";
import { withFault } from "../helpers/faults.ts";
import { git, makeRepos } from "../helpers/git.ts";
import { fakeInterrupts } from "../helpers/interrupts.ts";
import { type Isolation, isolate } from "../helpers/isolate.ts";

let iso: Isolation;
let codebase: string;
let repo: string;

beforeEach(() => {
  iso = isolate();
  codebase = join(iso.root, "shop");
  mkdirSync(join(codebase, ".crossrepo"), { recursive: true });
  makeRepos(codebase, { api: {} });
  repo = join(codebase, "api");
});

afterEach(() => {
  iso.restore();
});

const realGit = () =>
  createGit({ interactive: false, env: { ...process.env } });

/** Runs `body` in a real transaction; gives its error, or undefined. */
async function inTx(body: (tx: Tx) => Promise<unknown>): Promise<unknown> {
  const ctx = {
    out: { emit: () => {} },
    lock: {
      path: join(codebase, ".crossrepo", "xr.lock"),
      adapter: createLock(),
    },
    interrupts: fakeInterrupts(),
  };
  try {
    await transaction(ctx, body, { lock: "start" });
    return undefined;
  } catch (error) {
    return error;
  }
}

const boom = () => {
  throw new Error("later step failed");
};

function branches(): string[] {
  return git(repo, "branch", "--format=%(refname:short)")
    .split("\n")
    .filter(Boolean);
}

function worktrees(): number {
  return git(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree ")).length;
}

describe("chooseBranch", () => {
  test("local, tracking, else new from origin/<default>", async () => {
    const g = realGit();
    git(repo, "branch", "feat/local");
    git(repo, "push", "--quiet", "origin", "main:feat/remote");
    git(repo, "fetch", "--quiet", "origin");
    expect(await chooseBranch(g, repo, "feat/local", "main")).toEqual({
      source: "local",
      message: "local branch",
    });
    expect(await chooseBranch(g, repo, "feat/remote", "main")).toEqual({
      source: "tracking",
      message: "tracking origin/feat/remote",
      startPoint: "origin/feat/remote",
    });
    expect(await chooseBranch(g, repo, "feat/new", "trunk")).toEqual({
      source: "new",
      message: "new branch from origin/trunk",
      startPoint: "origin/trunk",
    });
  });
});

describe("addWorktreeStep", () => {
  const add = (
    tx: Tx,
    branch: string,
    choice: Awaited<ReturnType<typeof chooseBranch>>,
    g: Ctx["git"] = realGit(),
  ) =>
    addWorktreeStep({ fs: createFs(), git: g }, tx, {
      repo: "api",
      repoDir: repo,
      path: join(iso.root, "p", "api"),
      branch,
      choice,
    });

  test("undo of a new branch removes the worktree and deletes the branch", async () => {
    mkdirSync(join(iso.root, "p"));
    const g = realGit();
    const choice = await chooseBranch(g, repo, "feat/x", "main");
    const error = await inTx(async (tx) => {
      await add(tx, "feat/x", choice);
      expect(existsSync(join(iso.root, "p", "api", ".git"))).toBe(true);
      boom();
    });
    expect((error as Error).message).toBe("later step failed");
    expect(existsSync(join(iso.root, "p", "api"))).toBe(false);
    expect(worktrees()).toBe(1);
    expect(branches()).toEqual(["main"]);
  });

  test("undo keeps a local branch and a tracking branch", async () => {
    mkdirSync(join(iso.root, "p"));
    git(repo, "branch", "feat/local");
    git(repo, "push", "--quiet", "origin", "main:feat/remote");
    git(repo, "fetch", "--quiet", "origin");
    const g = realGit();
    for (const branch of ["feat/local", "feat/remote"]) {
      const choice = await chooseBranch(g, repo, branch, "main");
      await inTx(async (tx) => {
        await add(tx, branch, choice);
        boom();
      });
      expect(worktrees()).toBe(1);
    }
    expect(branches()).toEqual(["feat/local", "feat/remote", "main"]);
  });

  test("a failed add removes its folder, prunes, deletes a new branch, and throws", async () => {
    mkdirSync(join(iso.root, "p"));
    const g = realGit();
    const choice = await chooseBranch(g, repo, "feat/x", "main");
    const failing: Ctx["git"] = {
      ...g,
      async worktreeAdd(dir, path, how, options) {
        await g.worktreeAdd(dir, path, how, options);
        throw new Error("add failed late");
      },
    };
    const error = await inTx((tx) => add(tx, "feat/x", choice, failing));
    expect((error as Error).message).toBe("add failed late");
    expect(existsSync(join(iso.root, "p", "api"))).toBe(false);
    expect(worktrees()).toBe(1);
    expect(branches()).toEqual(["main"]);
  });

  test("a failed undo lists the cleanup commands", async () => {
    mkdirSync(join(iso.root, "p"));
    const g = withFault(realGit(), "worktreeRemove", 1);
    const choice = await chooseBranch(g, repo, "feat/x", "main");
    const error = await inTx(async (tx) => {
      await add(tx, "feat/x", choice, g);
      boom();
    });
    const path = join(iso.root, "p", "api");
    expect((error as XrError).blocks).toEqual([
      {
        type: "leftovers",
        items: [
          {
            what: "worktree of api",
            path: { path },
            command: {
              code: `git -C "${repo}" worktree remove --force "${path}" && git -C "${repo}" branch -D "feat/x"`,
            },
          },
        ],
      },
    ]);
  });
});

describe("makeProjectFolderStep", () => {
  test("makes each missing parent; undo removes only the folders it made", async () => {
    const fs = createFs();
    const projects = join(iso.root, "deep", "projects");
    const project = join(projects, "feat--x");
    mkdirSync(join(iso.root, "deep"));
    const error = await inTx(async (tx) => {
      await makeProjectFolderStep(fs, tx, project);
      expect(existsSync(project)).toBe(true);
      boom();
    });
    expect(error).toBeInstanceOf(Error);
    expect(existsSync(projects)).toBe(false);
    expect(existsSync(join(iso.root, "deep"))).toBe(true);
  });
});

describe("writeProjectRecordStep", () => {
  const record = {
    branch: "feat/x",
    codebase: "/c",
    repos: ["api"],
    created: "2026-10-20T14:03:12Z",
  };

  test("writes .crossrepo/project.yaml; undo removes the file and the folder it made", async () => {
    const fs = createFs();
    const project = join(iso.root, "proj");
    mkdirSync(project);
    const file = join(project, ".crossrepo", "project.yaml");
    const error = await inTx(async (tx) => {
      await writeProjectRecordStep(fs, tx, project, record);
      expect(readFileSync(file, "utf8")).toStartWith("branch: feat/x\n");
      boom();
    });
    expect(error).toBeInstanceOf(Error);
    expect(existsSync(join(project, ".crossrepo"))).toBe(false);
    expect(existsSync(project)).toBe(true);
  });

  test("an existing record: undo writes the old text back", async () => {
    const fs = createFs();
    const project = join(iso.root, "proj");
    const file = join(project, ".crossrepo", "project.yaml");
    mkdirSync(join(project, ".crossrepo"), { recursive: true });
    fs.writeText(file, "old: text\n");
    const error = await inTx(async (tx) => {
      await writeProjectRecordStep(fs, tx, project, record);
      expect(readFileSync(file, "utf8")).toStartWith("branch: feat/x\n");
      boom();
    });
    expect(error).toBeInstanceOf(Error);
    expect(readFileSync(file, "utf8")).toBe("old: text\n");
  });

  test("an existing record: the leftover command is byHand, else a fallback, never rm -rf", async () => {
    const fs = createFs();
    const project = join(iso.root, "proj");
    const file = join(project, ".crossrepo", "project.yaml");
    mkdirSync(join(project, ".crossrepo"), { recursive: true });
    fs.writeText(file, "old: text\n");
    const seen: Leftover[] = [];
    const tx: Tx = {
      signal: new AbortController().signal,
      step: async (_label, run, _undo, cleanup) => {
        seen.push(cleanup);
        return run(tx.signal);
      },
      finals: async () => {},
    };
    await writeProjectRecordStep(fs, tx, project, record, "Fix it by hand.");
    await writeProjectRecordStep(fs, tx, project, record);
    expect(seen).toEqual([
      { what: "project record", path: file, command: "Fix it by hand." },
      {
        what: "project record",
        path: file,
        command: `Write the old text of ${file} back by hand.`,
      },
    ]);
    for (const { command } of seen) expect(command).not.toContain("rm -rf");
  });
});
