import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLock } from "../../../src/adapters/lock/index.ts";
import { XrError } from "../../../src/errors/index.ts";
import { type Isolation, isolate } from "../../helpers/isolate.ts";

let iso: Isolation;
let dir: string;
let path: string;

beforeEach(() => {
  iso = isolate();
  dir = join(iso.root, ".crossrepo");
  mkdirSync(dir);
  path = join(dir, "xr.lock");
});

afterEach(() => {
  iso.restore();
});

/** The PID of a process that has ended. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ["-e", ""]);
  return result.pid as number;
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("createLock", () => {
  test("free: takes the lock with the PID inside and releases it", () => {
    const handle = createLock({ pid: 4242, isRunning: () => true }).acquire(
      path,
    );
    expect(readFileSync(path, "utf8")).toBe("4242\n");
    expect(handle.stalePid).toBeUndefined();
    handle.release();
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("release twice is fine", () => {
    const handle = createLock().acquire(path);
    handle.release();
    handle.release();
    expect(existsSync(path)).toBe(false);
  });

  test("release keeps a lock that another process holds now", () => {
    const handle = createLock({ pid: 1, isRunning: () => true }).acquire(path);
    writeFileSync(path, "2\n");
    handle.release();
    expect(readFileSync(path, "utf8")).toBe("2\n");
  });

  test("held by a running PID: lock-held with the PID, the lock stays", () => {
    writeFileSync(path, "777\n");
    const error = thrown(() =>
      createLock({ pid: 1, isRunning: (pid) => pid === 777 }).acquire(path),
    );
    expect(error).toBeInstanceOf(XrError);
    expect(error).toMatchObject({ code: "lock-held" });
    expect((error as XrError).message).toContain(
      "another xr command is running (pid 777)",
    );
    expect(readFileSync(path, "utf8")).toBe("777\n");
  });

  test("own PID: a second take in the same process fails", () => {
    const lock = createLock();
    const handle = lock.acquire(path);
    expect(thrown(() => lock.acquire(path))).toMatchObject({
      code: "lock-held",
      message: expect.stringContaining(`(pid ${process.pid})`),
    });
    handle.release();
  });

  test("stale: a PID that is not running is taken over", () => {
    const old = deadPid();
    writeFileSync(path, `${old}\n`);
    const handle = createLock().acquire(path);
    expect(handle.stalePid).toBe(old);
    expect(readFileSync(path, "utf8")).toBe(`${process.pid}\n`);
    handle.release();
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a lock with no PID in it is taken over", () => {
    writeFileSync(path, "junk\n");
    const handle = createLock({ pid: 5, isRunning: () => true }).acquire(path);
    expect(handle.stalePid).toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe("5\n");
  });

  test("a temp file left by a crash with the same PID is replaced", () => {
    writeFileSync(`${path}.4242-1.tmp`, "old\n");
    const handle = createLock({ pid: 4242, isRunning: () => true }).acquire(
      path,
    );
    expect(readFileSync(path, "utf8")).toBe("4242\n");
    handle.release();
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a PID too big for process.kill counts as no PID and is taken over", () => {
    writeFileSync(path, "2147483648\n");
    const handle = createLock().acquire(path);
    expect(handle.stalePid).toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe(`${process.pid}\n`);
    handle.release();
  });

  test("a takeover in progress by a running PID: lock-held", () => {
    writeFileSync(path, "10\n");
    writeFileSync(`${path}.takeover`, "11\n");
    const error = thrown(() =>
      createLock({ pid: 1, isRunning: (pid) => pid === 11 }).acquire(path),
    );
    expect(error).toMatchObject({
      code: "lock-held",
      message: expect.stringContaining("(pid 11)"),
    });
    expect(readFileSync(path, "utf8")).toBe("10\n");
  });

  test("a takeover guard left by a dead PID is removed, then the takeover runs", () => {
    writeFileSync(path, "10\n");
    writeFileSync(`${path}.takeover`, "11\n");
    const handle = createLock({
      pid: 1,
      isRunning: (pid) => pid === 1,
    }).acquire(path);
    expect(handle.stalePid).toBe(10);
    expect(readFileSync(path, "utf8")).toBe("1\n");
    expect(existsSync(`${path}.takeover`)).toBe(false);
  });

  test("a lock that changed during the takeover is not deleted", () => {
    writeFileSync(path, "10\n");
    // The first PID check sees 10 as dead; then a new process takes the lock.
    const isRunning = (pid: number) => {
      if (pid === 10) {
        writeFileSync(path, "20\n");
        return false;
      }
      return pid === 20;
    };
    const error = thrown(() => createLock({ pid: 1, isRunning }).acquire(path));
    expect(error).toMatchObject({
      code: "lock-held",
      message: expect.stringContaining("(pid 20)"),
    });
    expect(readFileSync(path, "utf8")).toBe("20\n");
    expect(existsSync(`${path}.takeover`)).toBe(false);
  });

  test("a missing folder is an error, not lock-held", () => {
    const error = thrown(() =>
      createLock().acquire(join(iso.root, "nope", "xr.lock")),
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(XrError);
  });
});

const child = fileURLToPath(
  new URL("../../helpers/lock-child.ts", import.meta.url),
);

/** Starts `count` processes that try to take the lock at the same time, and gives each result. */
async function race(count: number): Promise<string[]> {
  const go = join(iso.root, "go");
  const runs = Array.from({ length: count }, () => {
    const proc = spawn(process.execPath, [child, path, go], {
      env: { ...process.env },
    });
    let stdout = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    return new Promise<string>((resolve) =>
      proc.on("close", () => resolve(stdout.trim())),
    );
  });
  writeFileSync(go, "");
  return Promise.all(runs);
}

describe("createLock races between processes", () => {
  test("two takes at once: exactly one wins", async () => {
    const results = await race(4);
    expect(results.filter((r) => r === "won")).toHaveLength(1);
    expect(results.filter((r) => r === "lock-held")).toHaveLength(3);
  }, 20_000);

  test("two takeovers of a stale lock at once: exactly one wins", async () => {
    writeFileSync(path, `${deadPid()}\n`);
    const results = await race(4);
    expect(results.filter((r) => r === "won")).toHaveLength(1);
    expect(results.filter((r) => r === "lock-held")).toHaveLength(3);
    expect(existsSync(`${path}.takeover`)).toBe(false);
  }, 20_000);
});
