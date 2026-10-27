import { setImmediate, setTimeout } from "node:timers/promises";
import type { Lock, LockHandle } from "../adapters/lock/index.ts";
import { interrupted, withBlocks, XrError } from "../errors/index.ts";

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
      warning: {
        code: string;
        message: string;
        hint?: string;
        lines?: string[];
      };
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

/** One step of a delete phase. */
export interface FinalStep {
  label: string;
  run: () => unknown;
  manualCleanup: Leftover;
}

export interface Tx {
  /** Aborts on the first Ctrl-C, so work outside the steps, such as checks, can stop git. */
  readonly signal: AbortSignal;
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
   * The delete phase of a remove (AD-17): steps with no undo, never aborted, run
   * in order. When a step
   * fails, or Ctrl-C stops the phase after a step, that step (when it failed)
   * and every step not run are leftovers. Once the phase is done, the steps
   * before it are not undone, and a Ctrl-C after it does not make a body that
   * returns fail.
   */
  finals(steps: readonly FinalStep[]): Promise<void>;
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
  const undos: Undo[] = [];
  const leftovers: Leftover[] = [];
  let pending: Undo[] | undefined;
  let inFlight: Leftover | undefined;
  /** The final steps not started yet, once a `finals` phase has started. */
  let queued: Leftover[] = [];
  /** A `finals` phase ran to the end: nothing before it can be undone. */
  let finalsDone = false;
  let stepsDone = 0;
  let lock: LockHandle | undefined;
  let lockedAt = 0;

  const ctrlC = listenForInterrupts(ctx.interrupts, () => {
    const notDone =
      pending ?? [...undos].reverse().map(({ cleanup }) => ({ cleanup }));
    return withLeftovers(
      new XrError({
        code: "interrupted",
        message: "Stopped by a second Ctrl-C before the undo was done.",
      }),
      [
        ...(inFlight && !pending ? [inFlight] : []),
        ...leftovers,
        ...queued,
        ...notDone.map(({ cleanup }) => cleanup),
      ],
    );
  });

  function takeLock(): void {
    lock = acquireLock(ctx);
    lockedAt = stepsDone;
  }

  /** Lets a waiting Ctrl-C run, then stops before a new step after one. */
  async function checkpoint(): Promise<void> {
    await setImmediate();
    if (ctrlC.count > 0) throw interrupted();
  }

  async function afterStep(): Promise<void> {
    stepsDone += 1;
    if (lockAt === "after-first-step" && stepsDone === 1 && ctrlC.count === 0)
      takeLock();
    if (ctx.stepDelayMs) {
      await setTimeout(ctx.stepDelayMs, undefined, {
        signal: ctrlC.signal,
      }).catch(() => {});
    }
  }

  /** `onFailure` are the leftovers when `run` throws. */
  async function runStep<R>(
    label: string,
    run: () => R | Promise<R>,
    manualCleanup: Leftover,
    onFailure: readonly Leftover[],
  ): Promise<R> {
    await checkpoint();
    ctx.out.emit({ type: "step-start", text: label });
    inFlight = manualCleanup;
    try {
      return await run();
    } catch (error) {
      ctx.out.emit({ type: "step-end", text: label, ok: false });
      leftovers.push(...onFailure);
      throw ctrlC.count > 0 ? interrupted(error) : error;
    } finally {
      inFlight = undefined;
    }
  }

  const tx: Tx = {
    signal: ctrlC.signal,
    async step(label, run, undo, manualCleanup) {
      const result = await runStep(
        label,
        () => run(ctrlC.signal),
        manualCleanup,
        [],
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
    async finals(steps) {
      for (const [index, { label, run, manualCleanup }] of steps.entries()) {
        const rest = steps.slice(index).map((step) => step.manualCleanup);
        let started = false;
        try {
          await runStep(
            label,
            () => {
              started = true;
              queued = rest.slice(1);
              return run();
            },
            manualCleanup,
            rest,
          );
        } catch (error) {
          // Stopped by Ctrl-C between two steps: this step and the rest never ran.
          if (!started && index > 0) leftovers.push(...rest);
          queued = [];
          throw error;
        }
        ctx.out.emit({ type: "step-end", text: label, ok: true });
        await afterStep();
      }
      queued = [];
      undos.length = 0;
      finalsDone = true;
    },
  };

  async function undoAll(error: unknown): Promise<unknown> {
    pending = [...undos].reverse();
    while (pending.length > 0 && !ctrlC.abandoned) {
      const next = pending[0] as Undo;
      if (next.index < lockedAt) lock?.release();
      try {
        await next.undo();
      } catch {
        leftovers.push(next.cleanup);
      }
      pending.shift();
    }
    const reason = ctrlC.count > 0 ? interrupted() : error;
    return leftovers.length === 0 ? reason : withLeftovers(reason, leftovers);
  }

  const work = (async () => {
    try {
      if (lockAt === "start") takeLock();
      const result = await body(tx);
      // With nothing to undo, or after a done delete phase, a late Ctrl-C changes nothing more.
      if (ctrlC.count > 0 && undos.length > 0 && !finalsDone)
        throw interrupted();
      return result;
    } catch (error) {
      throw await undoAll(error);
    } finally {
      if (!ctrlC.abandoned) lock?.release();
    }
  })();
  return ctrlC.until(work);
}

/** The Ctrl-C state of one runner call. */
export interface InterruptListener {
  /** Aborts on the first Ctrl-C. */
  readonly signal: AbortSignal;
  /** How many Ctrl-C came so far. */
  readonly count: number;
  /** True after the second Ctrl-C: the runner gave up and must leave the lock. */
  readonly abandoned: boolean;
  /**
   * Waits for `work`, or fails at once with the second-Ctrl-C error, then stops
   * listening. Call it once, right after `work` starts.
   */
  until<T>(work: Promise<T>): Promise<T>;
}

/**
 * Makes the runner the SIGINT handler (AD-7): the first Ctrl-C aborts `signal`,
 * the second makes `until` fail at once with the error from `onSecond`.
 */
export function listenForInterrupts(
  interrupts: Interrupts,
  onSecond: () => XrError,
): InterruptListener {
  const controller = new AbortController();
  let count = 0;
  let abandoned = false;
  let failAtOnce: (error: XrError) => void = () => {};
  const atOnce = new Promise<never>((_, reject) => {
    failAtOnce = reject;
  });
  const stopListening = interrupts.on(() => {
    count += 1;
    if (count === 1) {
      controller.abort();
      return;
    }
    if (abandoned) return;
    abandoned = true;
    failAtOnce(onSecond());
  });
  return {
    signal: controller.signal,
    get count() {
      return count;
    },
    get abandoned() {
      return abandoned;
    },
    async until(work) {
      // After a second Ctrl-C nobody waits for `work`; bin.ts exits the process.
      work.catch(() => {});
      try {
        return await Promise.race([work, atOnce]);
      } finally {
        stopListening();
      }
    },
  };
}

/** Takes the codebase lock, with a `stale-lock` warning when it took over a dead process's lock. */
export function acquireLock(
  ctx: Pick<TransactionCtx, "out" | "lock">,
): LockHandle {
  const lock = ctx.lock.adapter.acquire(ctx.lock.path);
  if (lock.stalePid !== undefined) {
    ctx.out.emit({
      type: "warning",
      warning: {
        code: "stale-lock",
        message: `Took over the lock of pid ${lock.stalePid}, which is not running.`,
      },
    });
  }
  return lock;
}

/** Adds a `leftovers` error block to `error`. */
export function withLeftovers(
  error: unknown,
  items: readonly Leftover[],
): XrError {
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
