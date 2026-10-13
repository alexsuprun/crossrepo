import { linkSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { XrError } from "../../errors/index.ts";

/** A taken lock. */
export interface LockHandle {
  /** Deletes the lock file if it still holds this process's PID. Safe to call twice. */
  release(): void;
  /** The PID of the process that is not running and whose lock was taken over. */
  stalePid?: number;
}

/** The PID lock, as `ctx.lock.adapter`. Only the runners take it. */
export interface Lock {
  /** Takes the lock at `path` once, or throws `lock-held`. Never waits. Not re-entrant. */
  acquire(path: string): LockHandle;
}

export interface CreateLockOptions {
  /** The PID written to the lock. Default `process.pid`. */
  pid?: number;
  /** Whether a PID is a running process. Default: `process.kill(pid, 0)`. */
  isRunning?: (pid: number) => boolean;
}

/** How often `acquire` reads the lock again after it changed under it. It never sleeps. */
const MAX_TRIES = 5;

/** The biggest PID `process.kill` accepts. */
const MAX_PID = 2 ** 31 - 1;

interface Holder {
  text: string;
  pid: number | undefined;
}

/**
 * Builds the PID lock (AD-7, D55). The lock file is made with `link` from a full
 * temp file, so a reader never sees an empty lock. A lock whose PID is not running
 * is taken over under a `<path>.takeover` guard, which keeps two takeovers from
 * both winning. A reused PID looks like a running process, so its lock reads as held.
 */
export function createLock({
  pid = process.pid,
  isRunning = processIsRunning,
}: CreateLockOptions = {}): Lock {
  const own = `${pid}\n`;
  let temps = 0;

  /** Makes `path` with this PID inside; false when it exists. */
  function create(path: string): boolean {
    temps += 1;
    const temp = `${path}.${pid}-${temps}.tmp`;
    // A crash can leave a temp file with this name when the PID is reused.
    rmSync(temp, { force: true });
    writeFileSync(temp, own, { flag: "wx" });
    try {
      linkSync(temp, path);
      return true;
    } catch (error) {
      if (codeOf(error) === "EEXIST") return false;
      throw error;
    } finally {
      rmSync(temp, { force: true });
    }
  }

  function running(holder: Holder): boolean {
    return holder.pid !== undefined && isRunning(holder.pid);
  }

  /** Deletes `path` only if it still has `text`. The read and the delete are two calls. */
  function removeIfSame(path: string, text: string): boolean {
    if (read(path)?.text !== text) return false;
    rmSync(path, { force: true });
    return true;
  }

  /** Replaces the dead lock `seen` with this PID. False when something changed; the caller reads again. */
  function takeOver(path: string, seen: Holder): boolean {
    const guard = `${path}.takeover`;
    if (!create(guard)) {
      const taker = read(guard);
      if (taker === undefined) return false;
      if (running(taker)) throw held(taker.pid);
      removeIfSame(guard, taker.text);
      return false;
    }
    try {
      return removeIfSame(path, seen.text) && create(path);
    } finally {
      rmSync(guard, { force: true });
    }
  }

  return {
    acquire(path) {
      let last: Holder | undefined;
      for (let tries = 0; tries < MAX_TRIES; tries += 1) {
        if (create(path)) return handle(path, own);
        const seen = read(path);
        if (seen === undefined) continue;
        last = seen;
        if (running(seen)) throw held(seen.pid);
        if (takeOver(path, seen)) {
          return { ...handle(path, own), stalePid: seen.pid };
        }
      }
      throw held(last?.pid);
    },
  };
}

function handle(path: string, own: string): LockHandle {
  return {
    release() {
      if (read(path)?.text === own) rmSync(path, { force: true });
    },
  };
}

/** The lock text and its PID, or `undefined` when the file is gone. */
function read(path: string): Holder | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (codeOf(error) === "ENOENT") return undefined;
    throw error;
  }
  const pid = /^\d+$/.test(text.trim()) ? Number(text.trim()) : undefined;
  // `process.kill` throws a type error for a PID above the int32 range.
  return { text, pid: pid && pid > 0 && pid <= MAX_PID ? pid : undefined };
}

function held(pid: number | undefined): XrError {
  return new XrError({
    code: "lock-held",
    message: `another xr command is running (pid ${pid ?? "unknown"})`,
    hint: "Wait for it to end, then run the command again.",
  });
}

/** `ESRCH` means no such process; any other answer, such as `EPERM`, means it runs. */
function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return codeOf(error) !== "ESRCH";
  }
}

function codeOf(error: unknown): unknown {
  return (error as { code?: unknown }).code;
}
