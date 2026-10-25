import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createHooks,
  findSh,
  runHookLine,
} from "../../../src/adapters/hooks/index.ts";
import { XrError } from "../../../src/errors/index.ts";
import { type Isolation, isolate } from "../../helpers/isolate.ts";

let iso: Isolation;

beforeEach(() => {
  iso = isolate();
});

afterEach(() => {
  iso.restore();
});

const sh = () => findSh(process.platform, process.env);

function line(
  command: string,
  more: Partial<Parameters<typeof runHookLine>[0]> = {},
) {
  let written = "";
  const result = runHookLine({
    sh: sh(),
    command,
    cwd: iso.root,
    env: { ...process.env, HOOK_VAR: "from env" } as Record<string, string>,
    write: (text) => {
      written += text;
    },
    platform: process.platform,
    ...more,
  });
  return { result, written: () => written };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("findSh", () => {
  test("is /bin/sh on macOS and Linux", () => {
    expect(findSh("darwin", {}, () => false)).toBe("/bin/sh");
    expect(findSh("linux", {}, () => false)).toBe("/bin/sh");
  });

  const gitRoot = "C:\\Program Files\\Git";
  const onDisk =
    (...paths: string[]) =>
    (path: string) =>
      paths.includes(path);

  test("on Windows: git.exe in cmd\\ gives bin\\sh.exe of the install folder", () => {
    const exists = onDisk(
      win32.join(gitRoot, "cmd", "git.exe"),
      win32.join(gitRoot, "bin", "sh.exe"),
      win32.join(gitRoot, "usr", "bin", "sh.exe"),
    );
    expect(findSh("win32", { Path: `C:\\x;${gitRoot}\\cmd` }, exists)).toBe(
      win32.join(gitRoot, "bin", "sh.exe"),
    );
  });

  test("on Windows: a PATH entry in double quotes is read without them", () => {
    const exists = onDisk(
      win32.join(gitRoot, "cmd", "git.exe"),
      win32.join(gitRoot, "bin", "sh.exe"),
    );
    expect(findSh("win32", { PATH: `"${gitRoot}\\cmd"` }, exists)).toBe(
      win32.join(gitRoot, "bin", "sh.exe"),
    );
  });

  test("on Windows: else usr\\bin\\sh.exe, also from mingw64\\bin", () => {
    const exists = onDisk(
      win32.join(gitRoot, "mingw64", "bin", "git.exe"),
      win32.join(gitRoot, "usr", "bin", "sh.exe"),
    );
    expect(findSh("win32", { PATH: `${gitRoot}\\mingw64\\bin` }, exists)).toBe(
      win32.join(gitRoot, "usr", "bin", "sh.exe"),
    );
  });

  test("on Windows: no git.exe or no sh.exe is sh-not-found with a Git for Windows hint", () => {
    for (const exists of [
      onDisk(),
      onDisk(win32.join(gitRoot, "cmd", "git.exe")),
    ]) {
      let error: unknown;
      try {
        findSh("win32", { PATH: `${gitRoot}\\cmd` }, exists);
      } catch (thrown) {
        error = thrown;
      }
      expect(error).toBeInstanceOf(XrError);
      expect((error as XrError).code).toBe("sh-not-found");
      expect((error as XrError).hint).toContain("Git for Windows");
    }
  });
});

describe("runHookLine", () => {
  test("runs the line with sh -c in cwd with env; stdout and stderr go to write", async () => {
    const run = line('echo "out $HOOK_VAR"; echo err >&2; pwd > where.txt');
    expect(await run.result).toEqual({ ok: true });
    expect(run.written()).toContain("out from env");
    expect(run.written()).toContain("err");
    expect(existsSync(join(iso.root, "where.txt"))).toBe(true);
  });

  test("stdin is closed: a read gets end of file at once", async () => {
    const run = line("cat; echo done");
    expect(await run.result).toEqual({ ok: true });
    expect(run.written()).toContain("done");
  });

  test("a non-zero exit gives the exit code and the output", async () => {
    const run = line("echo one; echo two >&2; exit 3");
    const result = await run.result;
    expect(result).toMatchObject({ ok: false, exitCode: 3, timedOut: false });
    expect((result as { output: string }).output).toContain("one");
    expect((result as { output: string }).output).toContain("two");
  });

  test("a background child that keeps the pipes open does not hold the line", async () => {
    const pidFile = join(iso.root, "bg-pid");
    const run = line(`sleep 30 & echo $! > "${pidFile}"; echo hi`, {
      timeoutMs: 10_000,
    });
    const started = Date.now();
    expect(await run.result).toEqual({ ok: true });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(run.written()).toContain("hi");
    try {
      process.kill(Number(readFileSync(pidFile, "utf8").trim()));
    } catch {
      // Gone already.
    }
  });

  test("a timeout kills the line and says so", async () => {
    const run = line("sleep 30", { timeoutMs: 200 });
    const started = Date.now();
    const result = await run.result;
    expect(result).toMatchObject({ ok: false, timedOut: true });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("an aborted signal kills the line", async () => {
    const controller = new AbortController();
    const run = line("sleep 30", { signal: controller.signal });
    await sleep(200);
    controller.abort();
    expect(await run.result).toMatchObject({ ok: false });
  });

  test.skipIf(process.platform === "win32")(
    "abort kills the whole process tree, also a background child",
    async () => {
      const controller = new AbortController();
      const pidFile = join(iso.root, "pid");
      const run = line(`sleep 30 & echo $! > "${pidFile}"; wait`, {
        signal: controller.signal,
      });
      for (let i = 0; i < 50 && !existsSync(pidFile); i += 1) await sleep(50);
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      expect(alive(pid)).toBe(true);
      controller.abort();
      await run.result;
      for (let i = 0; i < 50 && alive(pid); i += 1) await sleep(50);
      expect(alive(pid)).toBe(false);
    },
  );
});

describe("runHookLine edge cases", () => {
  test("a signal aborted before the start runs nothing", async () => {
    const run = line("touch ran", { signal: AbortSignal.abort() });
    expect(await run.result).toMatchObject({ ok: false });
    expect(existsSync(join(iso.root, "ran"))).toBe(false);
  });

  test("an sh that cannot start gives a failure with the reason", async () => {
    const run = line("true", { sh: join(iso.root, "no-such-sh") });
    const result = await run.result;
    expect(result).toMatchObject({ ok: false, exitCode: null });
    expect((result as { output: string }).output).not.toBe("");
  });

  test("on win32 the kill uses taskkill, and a missing taskkill is not an error", async () => {
    const controller = new AbortController();
    const run = line("sleep 1", {
      signal: controller.signal,
      platform: "win32",
    });
    await sleep(100);
    controller.abort();
    expect(await run.result).toMatchObject({ ok: false });
  });
});

describe("createHooks", () => {
  test("finds sh once per run", () => {
    let looks = 0;
    const hooks = createHooks({
      platform: "win32",
      env: { PATH: "C:\\Git\\cmd" },
      write: () => {},
      exists: (path) => {
        looks += 1;
        return (
          path === "C:\\Git\\cmd\\git.exe" || path === "C:\\Git\\bin\\sh.exe"
        );
      },
    });
    expect(hooks.findSh()).toBe("C:\\Git\\bin\\sh.exe");
    const after = looks;
    expect(hooks.findSh()).toBe("C:\\Git\\bin\\sh.exe");
    expect(looks).toBe(after);
  });

  test("run uses the found sh and write", async () => {
    let written = "";
    const hooks = createHooks({
      platform: process.platform,
      env: process.env,
      write: (text) => {
        written += text;
      },
    });
    expect(
      await hooks.run({
        command: "echo hi",
        cwd: iso.root,
        env: { ...process.env } as Record<string, string>,
      }),
    ).toEqual({ ok: true });
    expect(written).toContain("hi");
  });
});
