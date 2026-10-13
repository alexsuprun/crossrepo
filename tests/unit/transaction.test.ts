import { describe, expect, test } from "bun:test";
import { exitCodeFor, XrError } from "../../src/errors/index.ts";
import {
  type TransactionCtx,
  transaction,
} from "../../src/runners/transaction.ts";
import { fakeInterrupts } from "../helpers/interrupts.ts";

interface RecorderOptions {
  acquire?: () => { stalePid?: number };
  stepDelayMs?: number;
}

function recorder({ acquire, stepDelayMs }: RecorderOptions = {}) {
  const events: unknown[] = [];
  const log: string[] = [];
  const interrupts = fakeInterrupts();
  const ctx: TransactionCtx = {
    out: { emit: (event) => void events.push(event) },
    lock: {
      path: "/c/.crossrepo/xr.lock",
      adapter: {
        acquire(path) {
          const result = acquire?.() ?? {};
          log.push(`lock ${path}`);
          let released = false;
          // Like the real lock, a second release does nothing.
          const release = () => {
            if (!released) log.push("release");
            released = true;
          };
          return { ...result, release };
        },
      },
    },
    interrupts,
    stepDelayMs,
  };
  return { ctx, events, log, interrupts };
}

const cleanup = (name: string) => ({
  what: name,
  path: `/c/${name}`,
  command: `rm /c/${name}`,
});

const leftover = (name: string) => ({
  what: name,
  path: { path: `/c/${name}` },
  command: { code: `rm /c/${name}` },
});

async function failure(run: Promise<unknown>): Promise<XrError> {
  const error = await run.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(XrError);
  return error as XrError;
}

/** A step body that waits until its signal aborts, then rejects. */
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
}

describe("transaction", () => {
  test("runs the steps in order with start and end events and returns the body result", async () => {
    const { ctx, events, log } = recorder();
    const result = await transaction(ctx, async (tx) => {
      const a = await tx.step(
        "Step a",
        () => 1,
        () => {},
        cleanup("a"),
      );
      const b = await tx.step(
        "Step b",
        async () => a + 1,
        () => {},
        cleanup("b"),
      );
      log.push(`got ${b}`);
      return "done";
    });
    expect(result).toBe("done");
    expect(log).toEqual(["lock /c/.crossrepo/xr.lock", "got 2", "release"]);
    expect(events).toEqual([
      { type: "step-start", text: "Step a" },
      { type: "step-end", text: "Step a", ok: true },
      { type: "step-start", text: "Step b" },
      { type: "step-end", text: "Step b", ok: true },
    ]);
  });

  test("a failed step undoes the done steps in reverse with their results, then throws its error", async () => {
    const { ctx, events, log } = recorder();
    const boom = new XrError({ code: "git-failed", message: "boom" });
    const run = transaction(ctx, async (tx) => {
      await tx.step(
        "a",
        () => "A",
        (r) => void log.push(`undo a ${r}`),
        cleanup("a"),
      );
      await tx.step(
        "b",
        () => "B",
        (r) => void log.push(`undo b ${r}`),
        cleanup("b"),
      );
      await tx.step(
        "c",
        () => {
          throw boom;
        },
        () => void log.push("undo c"),
        cleanup("c"),
      );
      await tx.step(
        "d",
        () => log.push("d ran"),
        () => {},
        cleanup("d"),
      );
    });
    await expect(run).rejects.toBe(boom);
    expect(log.slice(1)).toEqual(["undo b B", "undo a A", "release"]);
    expect(boom.blocks).toBeUndefined();
    expect(events.at(-1)).toEqual({ type: "step-end", text: "c", ok: false });
  });

  test("a body that throws after its steps also undoes them", async () => {
    const { ctx, log } = recorder();
    const run = transaction(ctx, async (tx) => {
      await tx.step(
        "a",
        () => {},
        () => void log.push("undo a"),
        cleanup("a"),
      );
      throw new Error("later");
    });
    await expect(run).rejects.toThrow("later");
    expect(log.slice(1)).toEqual(["undo a", "release"]);
  });

  test("a failed undo does not stop the other undos and adds a leftovers block", async () => {
    const { ctx, log } = recorder();
    const boom = new XrError({ code: "git-failed", message: "boom" });
    let thrown: unknown;
    try {
      await transaction(ctx, async (tx) => {
        await tx.step(
          "a",
          () => {},
          () => void log.push("undo a"),
          cleanup("a"),
        );
        await tx.step(
          "b",
          () => {},
          async () => {
            throw new Error("undo failed");
          },
          cleanup("b"),
        );
        await tx.step(
          "c",
          () => {},
          () => void log.push("undo c"),
          cleanup("c"),
        );
        await tx.step(
          "d",
          () => {
            throw boom;
          },
          () => {},
          cleanup("d"),
        );
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(boom);
    expect(log.slice(1)).toEqual(["undo c", "undo a", "release"]);
    expect(boom.blocks).toEqual([
      { type: "leftovers", items: [leftover("b")] },
    ]);
  });

  test("a plain error with leftovers becomes internal with the leftovers", async () => {
    const { ctx } = recorder();
    const cause = new Error("EACCES");
    let thrown: unknown;
    try {
      await transaction(ctx, async (tx) => {
        await tx.step(
          "a",
          () => {},
          () => {
            throw new Error("no");
          },
          cleanup("a"),
        );
        await tx.step(
          "b",
          () => {
            throw cause;
          },
          () => {},
          cleanup("b"),
        );
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(XrError);
    expect(thrown).toMatchObject({
      code: "internal",
      message: "EACCES",
      cause,
    });
    expect((thrown as XrError).blocks).toHaveLength(1);
  });
});

describe("transaction lock", () => {
  test("free: taken before the first step and released after the last", async () => {
    const { ctx, log } = recorder();
    await transaction(ctx, async (tx) => {
      await tx.step(
        "a",
        () => void log.push("a"),
        () => {},
        cleanup("a"),
      );
    });
    expect(log).toEqual(["lock /c/.crossrepo/xr.lock", "a", "release"]);
  });

  test("held: lock-held, no step runs and nothing is released", async () => {
    const { ctx, log, events, interrupts } = recorder({
      acquire: () => {
        throw new XrError({ code: "lock-held", message: "held" });
      },
    });
    const error = await failure(
      transaction(ctx, async (tx) => {
        await tx.step(
          "a",
          () => void log.push("a"),
          () => {},
          cleanup("a"),
        );
      }),
    );
    expect(error.code).toBe("lock-held");
    expect(exitCodeFor(error)).toBe(1);
    expect(log).toEqual([]);
    expect(events).toEqual([]);
    expect(interrupts.listening).toBe(0);
  });

  test("stale: a stale-lock warning with the old PID", async () => {
    const { ctx, events } = recorder({ acquire: () => ({ stalePid: 4321 }) });
    await transaction(ctx, async () => {});
    expect(events).toEqual([
      {
        type: "warning",
        warning: {
          code: "stale-lock",
          message: expect.stringContaining("pid 4321"),
        },
      },
    ]);
  });

  test("after-first-step: taken after step 1, released before the undo of step 1", async () => {
    const { ctx, log } = recorder();
    const run = transaction(
      ctx,
      async (tx) => {
        await tx.step(
          "a",
          () => void log.push("a"),
          () => void log.push("undo a"),
          cleanup("a"),
        );
        await tx.step(
          "b",
          () => void log.push("b"),
          () => void log.push("undo b"),
          cleanup("b"),
        );
        throw new Error("later");
      },
      { lock: "after-first-step" },
    );
    await expect(run).rejects.toThrow("later");
    expect(log).toEqual([
      "a",
      "lock /c/.crossrepo/xr.lock",
      "b",
      "undo b",
      "release",
      "undo a",
    ]);
  });

  test("after-first-step: a failed first step takes no lock", async () => {
    const { ctx, log } = recorder();
    const run = transaction(
      ctx,
      async (tx) => {
        await tx.step(
          "a",
          () => {
            throw new Error("no");
          },
          () => {},
          cleanup("a"),
        );
      },
      { lock: "after-first-step" },
    );
    await expect(run).rejects.toThrow("no");
    expect(log).toEqual([]);
  });

  test("after-first-step: a held lock undoes step 1", async () => {
    const { ctx, log } = recorder({
      acquire: () => {
        throw new XrError({ code: "lock-held", message: "held" });
      },
    });
    const error = await failure(
      transaction(
        ctx,
        async (tx) => {
          await tx.step(
            "a",
            () => void log.push("a"),
            () => void log.push("undo a"),
            cleanup("a"),
          );
        },
        { lock: "after-first-step" },
      ),
    );
    expect(error.code).toBe("lock-held");
    expect(log).toEqual(["a", "undo a"]);
  });

  test("listens for interrupts only while it runs", async () => {
    const { ctx, interrupts } = recorder();
    let during = 0;
    await transaction(ctx, async () => {
      during = interrupts.listening;
    });
    expect(during).toBe(1);
    expect(interrupts.listening).toBe(0);
  });
});

describe("transaction Ctrl-C", () => {
  test("during step N: the step is aborted, steps N-1..1 are undone in reverse, the lock is released", async () => {
    const { ctx, log, events, interrupts } = recorder();
    let seen: AbortSignal | undefined;
    const error = await failure(
      transaction(ctx, async (tx) => {
        await tx.step(
          "a",
          () => {},
          () => void log.push("undo a"),
          cleanup("a"),
        );
        await tx.step(
          "b",
          () => {},
          () => void log.push("undo b"),
          cleanup("b"),
        );
        await tx.step(
          "c",
          (signal) => {
            seen = signal;
            setTimeout(() => interrupts.fire(), 5);
            return untilAborted(signal);
          },
          () => void log.push("undo c"),
          cleanup("c"),
        );
        log.push("after c");
      }),
    );
    expect(error.code).toBe("interrupted");
    expect(exitCodeFor(error)).toBe(130);
    expect(error.blocks).toBeUndefined();
    expect(seen?.aborted).toBe(true);
    expect(log.slice(1)).toEqual(["undo b", "undo a", "release"]);
    expect(events.at(-1)).toEqual({ type: "step-end", text: "c", ok: false });
    expect(interrupts.listening).toBe(0);
  });

  test("a step that ends in spite of the abort is undone too", async () => {
    const { ctx, log, interrupts } = recorder();
    const error = await failure(
      transaction(ctx, async (tx) => {
        await tx.step(
          "a",
          async () => {
            interrupts.fire();
          },
          () => void log.push("undo a"),
          cleanup("a"),
        );
        await tx.step(
          "b",
          () => void log.push("b ran"),
          () => {},
          cleanup("b"),
        );
      }),
    );
    expect(error.code).toBe("interrupted");
    expect(log.slice(1)).toEqual(["undo a", "release"]);
  });

  test("lands between sync steps: no new step starts", async () => {
    const { ctx, log, interrupts } = recorder();
    const error = await failure(
      transaction(ctx, async (tx) => {
        await tx.step(
          "a",
          () => {
            log.push("a");
            setImmediate(() => interrupts.fire());
          },
          () => void log.push("undo a"),
          cleanup("a"),
        );
        await tx.step(
          "b",
          () => void log.push("b"),
          () => void log.push("undo b"),
          cleanup("b"),
        );
      }),
    );
    expect(error.code).toBe("interrupted");
    expect(log.slice(1)).toEqual(["a", "undo a", "release"]);
  });

  test("after the last step: every step is undone", async () => {
    const { ctx, log, interrupts } = recorder();
    const error = await failure(
      transaction(ctx, async (tx) => {
        await tx.step(
          "a",
          () => interrupts.fire(),
          () => void log.push("undo a"),
          cleanup("a"),
        );
      }),
    );
    expect(error.code).toBe("interrupted");
    expect(log.slice(1)).toEqual(["undo a", "release"]);
  });

  test("an undo that fails: the other undos run, the code stays interrupted, with leftovers", async () => {
    const { ctx, log, interrupts } = recorder();
    const error = await failure(
      transaction(ctx, async (tx) => {
        await tx.step(
          "a",
          () => {},
          () => void log.push("undo a"),
          cleanup("a"),
        );
        await tx.step(
          "b",
          () => {},
          () => {
            throw new Error("undo b failed");
          },
          cleanup("b"),
        );
        await tx.step(
          "c",
          () => interrupts.fire(),
          () => void log.push("undo c"),
          cleanup("c"),
        );
      }),
    );
    expect(error.code).toBe("interrupted");
    expect(exitCodeFor(error)).toBe(130);
    expect(log.slice(1)).toEqual(["undo c", "undo a", "release"]);
    expect(error.blocks).toEqual([
      { type: "leftovers", items: [leftover("b")] },
    ]);
  });

  test("a second Ctrl-C during undo: fails at once, leftovers are every undo not done, the lock stays", async () => {
    const { ctx, log, interrupts } = recorder();
    const error = await failure(
      transaction(ctx, async (tx) => {
        await tx.step(
          "a",
          () => {},
          () => void log.push("undo a"),
          cleanup("a"),
        );
        await tx.step(
          "b",
          () => {},
          () => {
            interrupts.fire();
            return new Promise<void>(() => {});
          },
          cleanup("b"),
        );
        await tx.step(
          "c",
          () => {},
          () => {
            throw new Error("undo c failed");
          },
          cleanup("c"),
        );
        interrupts.fire();
      }),
    );
    expect(error.code).toBe("interrupted");
    expect(exitCodeFor(error)).toBe(130);
    expect(error.blocks).toEqual([
      {
        type: "leftovers",
        items: [leftover("c"), leftover("b"), leftover("a")],
      },
    ]);
    expect(log).not.toContain("undo a");
    expect(log).not.toContain("release");
    expect(interrupts.listening).toBe(0);
  });

  test("a second Ctrl-C during a step that ignores the abort: the step and the done steps are leftovers", async () => {
    const { ctx, log, interrupts } = recorder();
    const error = await failure(
      transaction(ctx, async (tx) => {
        await tx.step(
          "a",
          () => {},
          () => void log.push("undo a"),
          cleanup("a"),
        );
        await tx.step(
          "b",
          () => {
            setTimeout(() => {
              interrupts.fire();
              interrupts.fire();
            }, 5);
            return new Promise<void>(() => {});
          },
          () => {},
          cleanup("b"),
        );
      }),
    );
    expect(error.code).toBe("interrupted");
    expect(error.blocks).toEqual([
      { type: "leftovers", items: [leftover("b"), leftover("a")] },
    ]);
    expect(log.slice(1)).toEqual([]);
  });
});

describe("transaction Ctrl-C during undo", () => {
  test("a first Ctrl-C during the undo of a failed step gives interrupted", async () => {
    const { ctx, log, interrupts } = recorder();
    const error = await failure(
      transaction(ctx, async (tx) => {
        await tx.step(
          "a",
          () => {},
          async () => {
            interrupts.fire();
            await new Promise((resolve) => setTimeout(resolve, 5));
            log.push("undo a");
          },
          cleanup("a"),
        );
        await tx.step(
          "b",
          () => {
            throw new XrError({ code: "git-failed", message: "boom" });
          },
          () => {},
          cleanup("b"),
        );
      }),
    );
    expect(error.code).toBe("interrupted");
    expect(exitCodeFor(error)).toBe(130);
    expect(log.slice(1)).toEqual(["undo a", "release"]);
  });

  test("after-first-step: a Ctrl-C during step 1 takes no lock", async () => {
    const { ctx, log, interrupts } = recorder();
    const error = await failure(
      transaction(
        ctx,
        async (tx) => {
          await tx.step(
            "a",
            () => interrupts.fire(),
            () => void log.push("undo a"),
            cleanup("a"),
          );
        },
        { lock: "after-first-step" },
      ),
    );
    expect(error.code).toBe("interrupted");
    expect(log).toEqual(["undo a"]);
  });
});

describe("tx.final", () => {
  test("runs with no undo and no signal, between start and end events", async () => {
    const { ctx, log, events } = recorder();
    const result = await transaction(ctx, async (tx) => {
      return tx.final(
        "Remove x",
        (...args: unknown[]) => {
          log.push(`final args ${args.length}`);
          return 7;
        },
        cleanup("x"),
      );
    });
    expect(result).toBe(7);
    expect(log.slice(1)).toEqual(["final args 0", "release"]);
    expect(events).toEqual([
      { type: "step-start", text: "Remove x" },
      { type: "step-end", text: "Remove x", ok: true },
    ]);
  });

  test("a failed final step stops and lists its cleanup as a leftover", async () => {
    const { ctx, log } = recorder();
    const boom = new XrError({ code: "git-failed", message: "boom" });
    const error = await failure(
      transaction(ctx, async (tx) => {
        await tx.final("x", () => void log.push("x"), cleanup("x"));
        await tx.final(
          "y",
          () => {
            throw boom;
          },
          cleanup("y"),
        );
        await tx.final("z", () => void log.push("z"), cleanup("z"));
      }),
    );
    expect(error).toBe(boom);
    expect(log.slice(1)).toEqual(["x", "release"]);
    expect(error.blocks).toEqual([
      { type: "leftovers", items: [leftover("y")] },
    ]);
  });

  test("Ctrl-C in a final step: it ends, then no new step starts", async () => {
    const { ctx, log, interrupts } = recorder();
    const error = await failure(
      transaction(ctx, async (tx) => {
        await tx.final(
          "x",
          async () => {
            interrupts.fire();
            await new Promise((resolve) => setTimeout(resolve, 5));
            log.push("x done");
          },
          cleanup("x"),
        );
        await tx.final("y", () => void log.push("y"), cleanup("y"));
      }),
    );
    expect(error.code).toBe("interrupted");
    expect(exitCodeFor(error)).toBe(130);
    expect(log.slice(1)).toEqual(["x done", "release"]);
    expect(error.blocks).toBeUndefined();
  });

  test("lock after-first-step counts a final step", async () => {
    const { ctx, log } = recorder();
    await transaction(
      ctx,
      async (tx) => {
        await tx.final("x", () => void log.push("x"), cleanup("x"));
        await tx.final("y", () => void log.push("y"), cleanup("y"));
      },
      { lock: "after-first-step" },
    );
    expect(log).toEqual(["x", "lock /c/.crossrepo/xr.lock", "y", "release"]);
  });
});

describe("transaction stepDelayMs", () => {
  test("waits after each step", async () => {
    const { ctx } = recorder({ stepDelayMs: 30 });
    const started = Date.now();
    await transaction(ctx, async (tx) => {
      await tx.step(
        "a",
        () => {},
        () => {},
        cleanup("a"),
      );
      await tx.step(
        "b",
        () => {},
        () => {},
        cleanup("b"),
      );
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
  });

  test("an interrupt ends the wait at once", async () => {
    const { ctx, log, interrupts } = recorder({ stepDelayMs: 60_000 });
    const error = await failure(
      transaction(ctx, async (tx) => {
        await tx.step(
          "a",
          () => {
            setTimeout(() => interrupts.fire(), 5);
          },
          () => void log.push("undo a"),
          cleanup("a"),
        );
      }),
    );
    expect(error.code).toBe("interrupted");
    expect(log.slice(1)).toEqual(["undo a", "release"]);
  });
});
