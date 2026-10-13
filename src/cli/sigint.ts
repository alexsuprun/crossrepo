import type { Interrupts } from "./index.ts";

/** The part of `process` that `sigintSource` uses. */
export interface SignalEmitter {
  on(event: "SIGINT", listener: () => void): unknown;
  off(event: "SIGINT", listener: () => void): unknown;
}

/** The SIGINT side of `ctx.interrupts`, and how many Ctrl-C it passed on. */
export interface SigintSource {
  interrupts: Interrupts;
  readonly count: number;
}

/**
 * Wires SIGINT to `ctx.interrupts`. It listens only while a handler is on, so
 * outside the runner Ctrl-C ends the process the default way.
 */
export function sigintSource(proc: SignalEmitter): SigintSource {
  const handlers = new Set<() => void>();
  let count = 0;
  function onSigint(): void {
    count += 1;
    for (const handler of [...handlers]) handler();
  }
  return {
    interrupts: {
      on(handler) {
        if (handlers.size === 0) proc.on("SIGINT", onSigint);
        handlers.add(handler);
        return () => {
          handlers.delete(handler);
          if (handlers.size === 0) proc.off("SIGINT", onSigint);
        };
      },
    },
    get count() {
      return count;
    },
  };
}

interface Flushable {
  write(text: string, done: () => void): unknown;
}

/** Calls `exit(code)` once stdout and stderr have flushed, so `exit` cannot cut piped output. */
export function exitAfterFlush(
  streams: { stdout: Flushable; stderr: Flushable },
  code: number,
  exit: (code: number) => void,
): void {
  let waiting = 2;
  const done = () => {
    waiting -= 1;
    if (waiting === 0) exit(code);
  };
  streams.stdout.write("", done);
  streams.stderr.write("", done);
}
