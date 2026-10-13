import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { exitAfterFlush, sigintSource } from "../../src/cli/sigint.ts";

describe("sigintSource", () => {
  test("listens for SIGINT only while a handler is on", () => {
    const proc = new EventEmitter();
    const source = sigintSource(proc);
    expect(proc.listenerCount("SIGINT")).toBe(0);
    const offA = source.interrupts.on(() => {});
    const offB = source.interrupts.on(() => {});
    expect(proc.listenerCount("SIGINT")).toBe(1);
    offA();
    expect(proc.listenerCount("SIGINT")).toBe(1);
    offB();
    expect(proc.listenerCount("SIGINT")).toBe(0);
  });

  test("calls every handler on SIGINT and counts each Ctrl-C", () => {
    const proc = new EventEmitter();
    const source = sigintSource(proc);
    const calls: string[] = [];
    source.interrupts.on(() => void calls.push("a"));
    source.interrupts.on(() => void calls.push("b"));
    expect(source.count).toBe(0);
    proc.emit("SIGINT");
    proc.emit("SIGINT");
    expect(calls).toEqual(["a", "b", "a", "b"]);
    expect(source.count).toBe(2);
  });

  test("a SIGINT with no handler on is not counted", () => {
    const proc = new EventEmitter();
    const source = sigintSource(proc);
    source.interrupts.on(() => {})();
    proc.emit("SIGINT");
    expect(source.count).toBe(0);
  });
});

describe("exitAfterFlush", () => {
  test("exits only after stdout and stderr are flushed", () => {
    const log: string[] = [];
    const flushes: (() => void)[] = [];
    const stream = (name: string) => ({
      write(text: string, done: () => void) {
        log.push(`write ${name} "${text}"`);
        flushes.push(done);
        return true;
      },
    });
    exitAfterFlush(
      { stdout: stream("out"), stderr: stream("err") },
      130,
      (code) => void log.push(`exit ${code}`),
    );
    expect(log).toEqual(['write out ""', 'write err ""']);
    flushes[0]?.();
    expect(log).toHaveLength(2);
    flushes[1]?.();
    expect(log.at(-1)).toBe("exit 130");
  });
});
