import { withBlocks } from "../errors/index.ts";

/** What a failed undo leaves behind, and the command that removes it by hand. */
export interface Leftover {
  what: string;
  path: string;
  command: string;
}

/** The live events the runner emits. `ctx.out` takes these and more. */
export type StepEvent =
  | { type: "step-start"; text: string }
  | { type: "step-end"; text: string; ok: boolean };

export interface TransactionCtx {
  out: { emit(event: StepEvent): void };
}

export interface Tx {
  /**
   * Runs `run` between a step-start and a step-end event. Its `undo` is kept
   * only when `run` succeeds, and gets the result of `run`.
   */
  step<T>(
    label: string,
    run: () => T | Promise<T>,
    undo: (result: T) => void | Promise<void>,
    manualCleanup: Leftover,
  ): Promise<T>;
}

/**
 * Runs `body` all-or-nothing (AD-7). When a step or the body throws, the done
 * steps are undone in reverse; a failed undo does not stop the others and adds
 * its `manualCleanup` to a `leftovers` error block. Then the first error is thrown.
 */
export async function transaction<T>(
  ctx: TransactionCtx,
  body: (tx: Tx) => Promise<T>,
): Promise<T> {
  const undos: { undo: () => void | Promise<void>; cleanup: Leftover }[] = [];
  const tx: Tx = {
    async step(label, run, undo, manualCleanup) {
      ctx.out.emit({ type: "step-start", text: label });
      let result: Awaited<ReturnType<typeof run>>;
      try {
        result = await run();
      } catch (error) {
        ctx.out.emit({ type: "step-end", text: label, ok: false });
        throw error;
      }
      undos.push({ undo: () => undo(result), cleanup: manualCleanup });
      ctx.out.emit({ type: "step-end", text: label, ok: true });
      return result;
    },
  };
  try {
    return await body(tx);
  } catch (error) {
    const leftovers: Leftover[] = [];
    for (const { undo, cleanup } of undos.reverse()) {
      try {
        await undo();
      } catch {
        leftovers.push(cleanup);
      }
    }
    if (leftovers.length === 0) throw error;
    throw withBlocks(error, [
      {
        type: "leftovers",
        items: leftovers.map(({ what, path, command }) => ({
          what,
          path: { path },
          command: { code: command },
        })),
      },
    ]);
  }
}
