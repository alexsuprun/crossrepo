import { setImmediate } from "node:timers/promises";
import type { LockHandle } from "../adapters/lock/index.ts";
import { XrError } from "../errors/index.ts";
import {
  acquireLock,
  interrupted,
  type Leftover,
  listenForInterrupts,
  type RunnerEvent,
  type TransactionCtx,
  withLeftovers,
} from "./transaction.ts";

export type RepoStatus = "ok" | "skipped" | "failed" | "conflict";

/** The result of one repo, as the `repos` block item and the `repo` event. */
export interface RepoResult {
  repo: string;
  status: RepoStatus;
  message?: string;
  hint?: string;
  /** What a stopped repo left on disk; it goes to a `leftovers` error block, not the result. */
  leftover?: Leftover;
}

export type PerRepoEvent =
  | RunnerEvent
  | {
      type: "repo";
      repo: string;
      status: RepoStatus;
      message?: string;
      hint?: string;
    };

export interface PerRepoCtx
  extends Omit<TransactionCtx, "out" | "stepDelayMs"> {
  out: { emit(event: PerRepoEvent): void };
}

export interface PerRepoOptions {
  /** The hint of the `repos-failed` error. */
  hint?: string;
}

const INTERRUPTED = "interrupted";

/**
 * Runs `run` for each repo, one at a time in the given order, under the codebase
 * lock (AD-7). There is no undo across repos. Each result is one `repo` event.
 * A throw from `run` is not caught. After the first Ctrl-C the repo in flight
 * keeps the result `run` returns (it gives `skipped`/`interrupted` when it was
 * stopped), every repo not reached is `skipped`/`interrupted`, and the run ends
 * with `interrupted`; else any `failed` repo ends it with
 * `repos-failed`. Both errors carry the `repos` block as a top-level Report
 * block. A second Ctrl-C fails at once and leaves the lock.
 */
export async function perRepo<T extends { name: string }>(
  ctx: PerRepoCtx,
  repos: readonly T[],
  run: (repo: T, signal: AbortSignal) => Promise<RepoResult>,
  options: PerRepoOptions = {},
): Promise<RepoResult[]> {
  const results: RepoResult[] = [];
  const leftovers: Leftover[] = [];
  const stopped = (repo: T): RepoResult => ({
    repo: repo.name,
    status: "skipped",
    message: INTERRUPTED,
  });
  const withRest = () => [
    ...results,
    ...repos.slice(results.length).map(stopped),
  ];
  const fail = (error: XrError, items: readonly RepoResult[]): XrError => {
    error.report = [{ type: "repos", items: [...items] }];
    return leftovers.length ? withLeftovers(error, leftovers) : error;
  };

  const ctrlC = listenForInterrupts(ctx.interrupts, () =>
    fail(
      new XrError({
        code: "interrupted",
        message: "Stopped by a second Ctrl-C.",
      }),
      withRest(),
    ),
  );

  const record = (result: RepoResult) => {
    results.push(result);
    ctx.out.emit({ type: "repo", ...result });
  };

  let lock: LockHandle | undefined;
  const work = (async () => {
    try {
      lock = acquireLock(ctx);
      for (const repo of repos) {
        // Lets a waiting Ctrl-C run before the next repo starts.
        await setImmediate();
        if (ctrlC.count > 0) {
          record(stopped(repo));
          continue;
        }
        const { leftover, ...result } = await run(repo, ctrlC.signal);
        if (leftover) leftovers.push(leftover);
        record(result);
      }
      if (ctrlC.count > 0) throw fail(interrupted(), results);
      const failed = results.filter((result) => result.status === "failed");
      if (failed.length) {
        throw fail(
          new XrError({
            code: "repos-failed",
            message: `${failed.length} of ${results.length} ${results.length === 1 ? "repo" : "repos"} failed: ${failed
              .map((result) => result.repo)
              .join(", ")}.`,
            hint: options.hint,
          }),
          results,
        );
      }
      return results;
    } finally {
      if (!ctrlC.abandoned) lock?.release();
    }
  })();
  return ctrlC.until(work);
}
