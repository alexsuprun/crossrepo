/** An in-process stand-in for SIGINT, the shape of `ctx.interrupts`. */
export interface FakeInterrupts {
  on(handler: () => void): () => void;
  /** Calls every handler, as one Ctrl-C would. */
  fire(): void;
  /** How many handlers listen now. */
  readonly listening: number;
}

export function fakeInterrupts(): FakeInterrupts {
  const handlers = new Set<() => void>();
  return {
    on(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    fire() {
      for (const handler of [...handlers]) handler();
    },
    get listening() {
      return handlers.size;
    },
  };
}
