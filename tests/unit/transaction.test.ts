import { describe, expect, test } from "bun:test";
import { XrError } from "../../src/errors/index.ts";
import { transaction } from "../../src/runners/transaction.ts";

function recorder() {
  const events: unknown[] = [];
  const log: string[] = [];
  return {
    ctx: { out: { emit: (event: unknown) => events.push(event) } },
    events,
    log,
  };
}

const cleanup = (name: string) => ({
  what: name,
  path: `/c/${name}`,
  command: `rm /c/${name}`,
});

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
    expect(log).toEqual(["got 2"]);
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
    expect(log).toEqual(["undo b B", "undo a A"]);
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
    expect(log).toEqual(["undo a"]);
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
    expect(log).toEqual(["undo c", "undo a"]);
    expect(boom.blocks).toEqual([
      {
        type: "leftovers",
        items: [
          { what: "b", path: { path: "/c/b" }, command: { code: "rm /c/b" } },
        ],
      },
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
