/**
 * A child process for the lock race tests. Args: the lock path and a "go" file.
 * Waits for the go file, tries to take the lock once and prints `won` or the
 * error code, then stays alive for 1.5 s so the winner's PID keeps counting as running.
 */
import { existsSync } from "node:fs";
import { createLock } from "../../src/adapters/lock/index.ts";

const [path, go] = process.argv.slice(2) as [string, string];
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms: number) => Atomics.wait(sleeper, 0, 0, ms);

while (!existsSync(go)) sleep(1);
let result: string;
try {
  createLock().acquire(path);
  result = "won";
} catch (error) {
  result = (error as { code?: string }).code ?? String(error);
}
process.stdout.write(`${result}\n`);
sleep(1500);
