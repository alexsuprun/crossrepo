import { setImmediate, setTimeout } from "node:timers/promises";
import type { Lock, LockHandle } from "../adapters/lock/index.ts";
import { withBlocks, XrError } from "../errors/index.ts";

/** What a failed undo leaves behind, and the command that removes it by hand. */
export interface Leftover {
  what: string;
  path: string;
  command: string;
}

/** The live events the runner emits. `ctx.out` takes these and more. */
export type RunnerEvent =
  | { type: "step-start"; text: string }
  | { type: "step-end"; text: string; ok: boolean }
  | {
      type: "warning";
      warning: { code: string; message: string; hint?: string };
    };

/** A Ctrl-C source. `on` gives the function that stops listening. */
export interface Interrupts {
  on(handler: () => void): () => void;
}

export interface TransactionCtx {
  out: { emit(event: RunnerEvent): void };
  /** `path` is `<codebase>/.crossrepo/xr.lock`, resolved by `cli`. */
  lock: { path: string; adapter: Lock };
  interrupts: Interrupts;
  /** Test only (`XR_TEST_STEP_DELAY_MS`): waits this long after each step. */
  stepDelayMs?: number;
}

export interface TransactionOptions {
  /** When to take the lock. `after-first-step` is for `codebase init`, whose first step makes `.crossrepo/`. Default `start`. */
  lock?: "start" | "after-first-step";
}

export interface Tx {
  /**
   * Runs `run` between a step-start and a step-end event. Its `undo` is kept
   * only when `run` succeeds, and gets the result of `run`. `signal` aborts on Ctrl-C.
   */
  step<T>(
    label: string,
    run: (signal: AbortSignal) => T | Promise<T>,
    undo: (result: T) => void | Promise<void>,
    manualCleanup: Leftover,
  ): Promise<T>;
  /**
   * A step with no undo, for the delete phase of a remove. It is never aborted.
   * When it fails, its `manualCleanup` is a leftover.
   */
  final<T>(
    label: string,
    run: () => T | Promise<T>,
    manualCleanup: Leftover,
  ): Promise<T>;
}

interface Undo {
  /** The number of steps done before this one; the lock is released before undos below `lockedAt`. */
  index: number;
  undo: () => void | Promise<void>;
  cleanup: Leftover;
}

/**
 * Runs `body` all-or-nothing under the codebase lock (AD-7). When a step or the
 * body throws, or on Ctrl-C, the done steps are undone in reverse; a failed undo
 * does not stop the others and adds its `manualCleanup` to a `leftovers` error
 * block. Then the first error is thrown, or `interrupted` after a Ctrl-C.
 * A second Ctrl-C fails at once with every undo not done as a leftover, and
 * leaves the lock for the next command to take over.
 */
export async function transaction<T>(
  ctx: TransactionCtx,
  body: (tx: Tx) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const lockAt = options.lock ?? "start";
  const controller = new AbortController();
  const undos: Undo[] = [];
  const leftovers: Leftover[] = [];
  let pending: Undo[] | undefined;
  let inFlight: Leftover | undefined;
  let stepsDone = 0;
  let interrupts = 0;
  let abandoned = false;
  let lock: LockHandle | undefined;
  let lockedAt = 0;

  let failAtOnce: (error: XrError) => void = () => {};
  const atOnce = new Promise<never>((_, reject) => {
    failAtOnce = reject;
  });

  const stopListening = ctx.interrupts.on(() => {
    interrupts += 1;
    if (interrupts === 1) {
      controller.abort();
      return;
    }
    if (abandoned) return;
    abandoned = true;
    const notDone =
      pending ?? [...undos].reverse().map(({ cleanup }) => ({ cleanup }));
    failAtOnce(
      withLeftovers(
        new XrError({
          code: "interrupted",
          message: "Stopped by a second Ctrl-C before the undo was done.",
        }),
        [
          ...(inFlight && !pending ? [inFlight] : []),
          ...leftovers,
          ...notDone.map(({ cleanup }) => cleanup),
        ],
      ),
    );
  });

  function takeLock(): void {
    lock = ctx.lock.adapter.acquire(ctx.lock.path);
    lockedAt = stepsDone;
    if (lock.stalePid !== undefined) {
      ctx.out.emit({
        type: "warning",
        warning: {
          code: "stale-lock",
          message: `Took over the lock of pid ${lock.stalePid}, which is not running.`,
        },
      });
    }
  }

  /** Lets a waiting Ctrl-C run, then stops before a new step after one. */
  async function checkpoint(): Promise<void> {
    await setImmediate();
    if (interrupts > 0) throw interrupted();
  }

  async function afterStep(): Promise<void> {
    stepsDone += 1;
    if (lockAt === "after-first-step" && stepsDone === 1 && interrupts === 0)
      takeLock();
    if (ctx.stepDelayMs) {
      await setTimeout(ctx.stepDelayMs, undefined, {
        signal: controller.signal,
      }).catch(() => {});
    }
  }

  async function runStep<R>(
    label: string,
    run: () => R | Promise<R>,
    manualCleanup: Leftover,
    final: boolean,
  ): Promise<R> {
    await checkpoint();
    ctx.out.emit({ type: "step-start", text: label });
    inFlight = manualCleanup;
    try {
      return await run();
    } catch (error) {
      ctx.out.emit({ type: "step-end", text: label, ok: false });
      if (final) leftovers.push(manualCleanup);
      throw interrupts > 0 ? interrupted() : error;
    } finally {
      inFlight = undefined;
    }
  }

  const tx: Tx = {
    async step(label, run, undo, manualCleanup) {
      const result = await runStep(
        label,
        () => run(controller.signal),
        manualCleanup,
        false,
      );
      undos.push({
        index: stepsDone,
        undo: () => undo(result),
        cleanup: manualCleanup,
      });
      ctx.out.emit({ type: "step-end", text: label, ok: true });
      await afterStep();
      return result;
    },
    async final(label, run, manualCleanup) {
      const result = await runStep(label, () => run(), manualCleanup, true);
      ctx.out.emit({ type: "step-end", text: label, ok: true });
      await afterStep();
      return result;
    },
  };

  async function undoAll(error: unknown): Promise<unknown> {
    pending = [...undos].reverse();
    while (pending.length > 0 && !abandoned) {
      const next = pending[0] as Undo;
      if (next.index < lockedAt) lock?.release();
      try {
        await next.undo();
      } catch {
        leftovers.push(next.cleanup);
      }
      pending.shift();
    }
    const reason = interrupts > 0 ? interrupted() : error;
    return leftovers.length === 0 ? reason : withLeftovers(reason, leftovers);
  }

  const work = (async () => {
    try {
      if (lockAt === "start") takeLock();
      const result = await body(tx);
      if (interrupts > 0) throw interrupted();
      return result;
    } catch (error) {
      throw await undoAll(error);
    } finally {
      if (!abandoned) lock?.release();
    }
  })();
  // After a second Ctrl-C nobody waits for `work`; bin.ts exits the process.
  work.catch(() => {});
  try {
    return await Promise.race([work, atOnce]);
  } finally {
    stopListening();
  }
}

function interrupted(): XrError {
  return new XrError({
    code: "interrupted",
    message: "Stopped by Ctrl-C.",
  });
}

function withLeftovers(error: unknown, items: readonly Leftover[]): XrError {
  return withBlocks(error, [
    {
      type: "leftovers",
      items: items.map(({ what, path, command }) => ({
        what,
        path: { path },
        command: { code: command },
      })),
    },
  ]);
}
