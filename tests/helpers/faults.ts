/**
 * Gives a copy of `adapter` whose `method` throws on its `nth` call (1-based).
 * Every other call goes to the real method.
 */
export function withFault<T extends object, K extends keyof T>(
  adapter: T,
  method: K,
  nth: number,
  error: unknown = new Error(`fault in ${String(method)} call ${nth}`),
): T {
  const real = adapter[method];
  if (typeof real !== "function") {
    throw new Error(`${String(method)} is not a method`);
  }
  let calls = 0;
  return {
    ...adapter,
    [method]: (...args: unknown[]) => {
      calls += 1;
      if (calls === nth) throw error;
      return real.apply(adapter, args);
    },
  };
}
