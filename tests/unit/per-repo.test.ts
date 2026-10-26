import { describe, expect, test } from "bun:test";
import { exitCodeFor, XrError } from "../../src/errors/index.ts";
import {
  type PerRepoCtx,
  perRepo,
  type RepoResult,
} from "../../src/runners/per-repo.ts";
import { fakeInterrupts } from "../helpers/interrupts.ts";

function recorder({ acquire }: { acquire?: () => { stalePid?: number } } = {}) {
  const events: unknown[] = [];
  const log: string[] = [];
  const interrupts = fakeInterrupts();
  const ctx: PerRepoCtx = {
    out: { emit: (event) => void events.push(event) },
    lock: {
      path: "/c/.crossrepo/xr.lock",
      adapter: {
        acquire(path) {
          const result = acquire?.() ?? {};
          log.push(`lock ${path}`);
          return { ...result, release: () => void log.push("release") };
        },
      },
    },
    interrupts,
  };
  return { ctx, events, log, interrupts };
}

const repos = [{ name: "api" }, { name: "web" }, { name: "docs" }];

async function failure(run: Promise<unknown>): Promise<XrError> {
  const error = await run.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(XrError);
  return error as XrError;
}

const interruptedItem = (repo: string): RepoResult => ({
  repo,
  status: "skipped",
  message: "interrupted",
});

describe("perRepo", () => {
  test("takes the lock first, runs each repo in order, emits one repo event each, and returns the results", async () => {
    const { ctx, events, log, interrupts } = recorder();
    const results = await perRepo(ctx, repos, async ({ name }) => {
      log.push(`run ${name}`);
      return name === "web"
        ? { repo: name, status: "skipped", message: "already on disk" }
        : { repo: name, status: "ok" };
    });
    expect(log).toEqual([
      "lock /c/.crossrepo/xr.lock",
      "run api",
      "run web",
      "run docs",
      "release",
    ]);
    expect(results).toEqual([
      { repo: "api", status: "ok" },
      { repo: "web", status: "skipped", message: "already on disk" },
      { repo: "docs", status: "ok" },
    ]);
    expect(events).toEqual(
      results.map((result) => ({ type: "repo", ...result })),
    );
    expect(interrupts.listening).toBe(0);
  });

  test("runs one repo at a time", async () => {
    const { ctx } = recorder();
    let running = 0;
    let most = 0;
    await perRepo(ctx, repos, async ({ name }) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
      return { repo: name, status: "ok" };
    });
    expect(most).toBe(1);
  });

  test("repos as a function: it is called once the lock is held, and a throw from it releases the lock", async () => {
    const { ctx, log } = recorder();
    const results = await perRepo(
      ctx,
      () => {
        log.push("list");
        return [{ name: "api" }];
      },
      async ({ name }) => ({ repo: name, status: "ok" }),
    );
    expect(results).toEqual([{ repo: "api", status: "ok" }]);
    expect(log).toEqual(["lock /c/.crossrepo/xr.lock", "list", "release"]);

    const gone = recorder();
    const boom = new XrError({ code: "project-not-found", message: "gone" });
    const error = await failure(
      perRepo(
        gone.ctx,
        () => {
          throw boom;
        },
        async ({ name }: { name: string }) => ({ repo: name, status: "ok" }),
      ),
    );
    expect(error).toBe(boom);
    expect(gone.log.at(-1)).toBe("release");
  });

  test("no repos: takes and releases the lock and returns an empty list", async () => {
    const { ctx, log, events } = recorder();
    expect(
      await perRepo(ctx, [], async () => ({ repo: "x", status: "ok" })),
    ).toEqual([]);
    expect(log).toEqual(["lock /c/.crossrepo/xr.lock", "release"]);
    expect(events).toEqual([]);
  });

  test("a stale lock gives a stale-lock warning", async () => {
    const { ctx, events } = recorder({ acquire: () => ({ stalePid: 4321 }) });
    await perRepo(ctx, [], async () => ({ repo: "x", status: "ok" }));
    expect(events).toEqual([
      {
        type: "warning",
        warning: {
          code: "stale-lock",
          message: "Took over the lock of pid 4321, which is not running.",
        },
      },
    ]);
  });

  test("a held lock: no repo runs", async () => {
    const { ctx, log } = recorder({
      acquire: () => {
        throw new XrError({ code: "lock-held", message: "held" });
      },
    });
    const error = await failure(
      perRepo(ctx, repos, async ({ name }) => {
        log.push(`run ${name}`);
        return { repo: name, status: "ok" };
      }),
    );
    expect(error.code).toBe("lock-held");
    expect(log).toEqual([]);
  });

  test("a failed repo does not stop the others; the end is repos-failed with the repos block", async () => {
    const { ctx, log, interrupts } = recorder();
    const error = await failure(
      perRepo(
        ctx,
        repos,
        async ({ name }) => {
          log.push(`run ${name}`);
          return name === "api"
            ? { repo: name, status: "failed", message: "boom", hint: "fix it" }
            : { repo: name, status: "ok" };
        },
        { hint: "Fix the failed repos." },
      ),
    );
    expect(error.code).toBe("repos-failed");
    expect(exitCodeFor(error)).toBe(1);
    expect(error.message).toBe("1 of 3 repos failed: api.");
    expect(error.hint).toBe("Fix the failed repos.");
    expect(error.report).toEqual([
      {
        type: "repos",
        items: [
          { repo: "api", status: "failed", message: "boom", hint: "fix it" },
          { repo: "web", status: "ok" },
          { repo: "docs", status: "ok" },
        ],
      },
    ]);
    expect(error.blocks).toBeUndefined();
    expect(log).toContain("run docs");
    expect(log.at(-1)).toBe("release");
    expect(interrupts.listening).toBe(0);
  });

  test("a conflict repo fails the run with repos-failed and does not stop the others", async () => {
    const { ctx, events, log } = recorder();
    const conflict: RepoResult = {
      repo: "web",
      status: "conflict",
      message: "merge conflict in 1 file: `a.ts`",
      hint: "fix it",
      files: ["a.ts"],
      stashKept: false,
    };
    const error = await failure(
      perRepo(
        ctx,
        repos,
        async ({ name }) => {
          log.push(`run ${name}`);
          return name === "web" ? conflict : { repo: name, status: "ok" };
        },
        { hint: "Fix each failed repo." },
      ),
    );
    expect(error.code).toBe("repos-failed");
    expect(exitCodeFor(error)).toBe(1);
    expect(error.message).toBe("1 of 3 repos has conflicts: web.");
    expect(error.hint).toBe("Fix each failed repo.");
    const items = [
      { repo: "api", status: "ok" },
      conflict,
      { repo: "docs", status: "ok" },
    ];
    expect(error.report).toEqual([{ type: "repos", items }]);
    expect(events).toEqual(items.map((item) => ({ type: "repo", ...item })));
    expect(log).toContain("run docs");
    expect(log.at(-1)).toBe("release");
  });

  test("failed and conflict repos: the message counts both and names them in order", async () => {
    const { ctx } = recorder();
    const error = await failure(
      perRepo(ctx, repos, async ({ name }) =>
        name === "api"
          ? { repo: name, status: "failed", message: "boom" }
          : name === "web"
            ? { repo: name, status: "conflict", stashKept: true }
            : { repo: name, status: "ok" },
      ),
    );
    expect(error.code).toBe("repos-failed");
    expect(error.message).toBe(
      "1 of 3 repos failed, 1 has conflicts: api, web.",
    );
  });

  test("two conflict repos: the message uses have", async () => {
    const { ctx } = recorder();
    const error = await failure(
      perRepo(ctx, repos, async ({ name }) =>
        name === "api"
          ? { repo: name, status: "ok" }
          : { repo: name, status: "conflict" },
      ),
    );
    expect(error.message).toBe("2 of 3 repos have conflicts: web, docs.");
  });

  test("a throw from the callback is not caught: it ends the run and the lock is released", async () => {
    const { ctx, log } = recorder();
    const boom = new XrError({ code: "git-too-old", message: "old" });
    const error = await failure(
      perRepo(ctx, repos, async () => {
        throw boom;
      }),
    );
    expect(error).toBe(boom);
    expect(log.at(-1)).toBe("release");
  });

  test("Ctrl-C during a repo: it and every repo not reached are skipped/interrupted, the done ones keep their status", async () => {
    const { ctx, events, log, interrupts } = recorder();
    let seen: AbortSignal | undefined;
    const error = await failure(
      perRepo(ctx, repos, async ({ name }, signal) => {
        log.push(`run ${name}`);
        if (name === "web") {
          seen = signal;
          interrupts.fire();
          return { repo: name, status: "failed", message: "stopped late" };
        }
        return { repo: name, status: "ok" };
      }),
    );
    expect(seen?.aborted).toBe(true);
    expect(error.code).toBe("interrupted");
    expect(exitCodeFor(error)).toBe(130);
    expect(error.message).toBe("Stopped by Ctrl-C.");
    const items = [
      { repo: "api", status: "ok" },
      { repo: "web", status: "failed", message: "stopped late" },
      interruptedItem("docs"),
    ];
    expect(error.report).toEqual([{ type: "repos", items }]);
    expect(error.blocks).toBeUndefined();
    expect(events).toEqual(items.map((item) => ({ type: "repo", ...item })));
    expect(log).not.toContain("run docs");
    expect(log.at(-1)).toBe("release");
    expect(interrupts.listening).toBe(0);
  });

  test("Ctrl-C between repos: the repos not reached are skipped/interrupted", async () => {
    const { ctx, log, interrupts } = recorder();
    const error = await failure(
      perRepo(ctx, repos, async ({ name }) => {
        log.push(`run ${name}`);
        if (name === "api") setImmediate(() => interrupts.fire());
        return { repo: name, status: "ok" };
      }),
    );
    expect(error.code).toBe("interrupted");
    expect(error.report).toEqual([
      {
        type: "repos",
        items: [
          { repo: "api", status: "ok" },
          interruptedItem("web"),
          interruptedItem("docs"),
        ],
      },
    ]);
    expect(log).toEqual(["lock /c/.crossrepo/xr.lock", "run api", "release"]);
  });

  test("a leftover of the stopped repo is a leftovers error block, not part of the result", async () => {
    const { ctx, interrupts } = recorder();
    const error = await failure(
      perRepo(ctx, repos, async ({ name }) => {
        interrupts.fire();
        return {
          repo: name,
          status: "skipped",
          message: "interrupted",
          leftover: {
            what: "partial clone",
            path: "/c/api",
            command: 'rm -r "/c/api"',
          },
        };
      }),
    );
    expect(error.code).toBe("interrupted");
    expect(error.blocks).toEqual([
      {
        type: "leftovers",
        items: [
          {
            what: "partial clone",
            path: { path: "/c/api" },
            command: { code: 'rm -r "/c/api"' },
          },
        ],
      },
    ]);
    expect(error.report).toEqual([
      {
        type: "repos",
        items: repos.map(({ name }) => interruptedItem(name)),
      },
    ]);
  });

  test("a second Ctrl-C fails at once, the lock stays, and the repos not done are interrupted", async () => {
    const { ctx, log, interrupts } = recorder();
    const error = await failure(
      perRepo(ctx, repos, async ({ name }) => {
        if (name === "api") return { repo: name, status: "ok" };
        interrupts.fire();
        interrupts.fire();
        return new Promise<never>(() => {});
      }),
    );
    expect(error.code).toBe("interrupted");
    expect(exitCodeFor(error)).toBe(130);
    expect(error.message).toBe("Stopped by a second Ctrl-C.");
    expect(error.report).toEqual([
      {
        type: "repos",
        items: [
          { repo: "api", status: "ok" },
          interruptedItem("web"),
          interruptedItem("docs"),
        ],
      },
    ]);
    expect(log).not.toContain("release");
    expect(interrupts.listening).toBe(0);
  });
});
