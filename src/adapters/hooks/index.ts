import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";
import { XrError } from "../../errors/index.ts";

/** The fixed time one hook line may run (AD-11). */
export const HOOK_TIMEOUT_MS = 10 * 60 * 1000;

/** The most output a hook line keeps for its error, from the end. */
const KEPT_OUTPUT = 64 * 1024;

/** How long a line's output may still come after `sh` exits. */
const EXIT_GRACE_MS = 100;

/** What one hook line gave. `output` is the end of its stdout and stderr together. */
export type HookResult =
  | { ok: true }
  | {
      ok: false;
      /** `null` when a signal stopped it. */
      exitCode: number | null;
      timedOut: boolean;
      output: string;
    };

export interface HookLineRun {
  sh: string;
  command: string;
  cwd: string;
  env: Readonly<Record<string, string>>;
  /** Aborting it kills the process tree of the line. */
  signal?: AbortSignal;
  /** Default 10 minutes. */
  timeoutMs?: number;
  /** Gets the live stdout and stderr of the line. */
  write: (text: string) => void;
  platform: NodeJS.Platform;
}

/** One hook line to run with the found `sh`. */
export interface HookLine {
  command: string;
  cwd: string;
  env: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}

/** The hooks adapter, as `ctx.hooks`. The only code that starts `sh` (AD-11). */
export interface Hooks {
  /** The `sh` to use, found once per run. Throws `sh-not-found`. */
  findSh(): string;
  /** Runs one line with `sh -c`, stdin closed, output to the run's `write`. */
  run(line: HookLine): Promise<HookResult>;
}

export interface CreateHooksOptions {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  /** Gets the live hook output: the process stderr in `cli`, in every mode. */
  write: (text: string) => void;
  /** Default 10 minutes. */
  timeoutMs?: number;
  /** Default `fs.existsSync`. */
  exists?: (path: string) => boolean;
}

export function createHooks({
  platform,
  env,
  write,
  timeoutMs = HOOK_TIMEOUT_MS,
  exists = existsSync,
}: CreateHooksOptions): Hooks {
  let found: string | undefined;
  const sh = () => {
    found ??= findSh(platform, env, exists);
    return found;
  };
  return {
    findSh: sh,
    run: (line) =>
      runHookLine({ ...line, sh: sh(), timeoutMs, write, platform }),
  };
}

/**
 * `/bin/sh` on macOS and Linux. On Windows: `git.exe` on `PATH`, then up to the
 * Git for Windows install folder, `bin\sh.exe`, else `usr\bin\sh.exe` (D48).
 * Throws `sh-not-found`.
 */
export function findSh(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  exists: (path: string) => boolean = existsSync,
): string {
  if (platform !== "win32") return "/bin/sh";
  const pathVar = Object.entries(env).find(
    ([name]) => name.toUpperCase() === "PATH",
  )?.[1];
  const dirs = (pathVar ?? "")
    .split(";")
    .map((dir) => dir.replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
  for (const dir of dirs) {
    if (!exists(win32.join(dir, "git.exe"))) continue;
    // git.exe is in `cmd\`, `bin\` or `mingw64\bin\` of the install folder.
    for (let up = win32.resolve(dir), step = 0; step < 3; step += 1) {
      for (const sh of [
        win32.join(up, "bin", "sh.exe"),
        win32.join(up, "usr", "bin", "sh.exe"),
      ]) {
        if (exists(sh)) return sh;
      }
      up = win32.dirname(up);
    }
  }
  throw new XrError({
    code: "sh-not-found",
    message:
      "No `sh` found: xr runs hooks with the `sh.exe` of Git for Windows, and found no `git.exe` with it on PATH.",
    hint: "Install Git for Windows (https://gitforwindows.org), which has `sh.exe`, then run the command again.",
  });
}

/**
 * Runs `sh -c <command>` in its own process group (POSIX) with stdin closed.
 * On abort or timeout it kills the whole process tree at once (AD-11).
 */
export function runHookLine({
  sh,
  command,
  cwd,
  env,
  signal,
  timeoutMs = HOOK_TIMEOUT_MS,
  write,
  platform,
}: HookLineRun): Promise<HookResult> {
  return new Promise((resolve) => {
    let kept = "";
    let timedOut = false;
    let aborted = false;
    let done = false;
    const keep = (chunk: string) => {
      write(chunk);
      kept = (kept + chunk).slice(-KEPT_OUTPUT);
    };
    if (signal?.aborted) {
      resolve({ ok: false, exitCode: null, timedOut, output: "" });
      return;
    }
    const child = spawn(sh, ["-c", command], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: platform !== "win32",
      windowsHide: true,
    });
    const kill = () => killTree(child.pid, platform);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const finish = (result: HookResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", keep);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", keep);
    child.on("error", (error) => {
      finish({
        ok: false,
        exitCode: null,
        timedOut,
        output: `${kept}${error.message}\n`,
      });
    });
    // Ends on `exit`, not `close`: a background child of the line may hold the pipes open.
    child.on("exit", (code) => {
      const result: HookResult =
        code === 0 && !timedOut && !aborted
          ? { ok: true }
          : { ok: false, exitCode: code, timedOut, output: kept };
      const end = () => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(result);
      };
      // Output still in the pipes arrives before `close`; wait a little for it.
      const grace = setTimeout(end, EXIT_GRACE_MS);
      child.on("close", () => {
        clearTimeout(grace);
        end();
      });
    });
  });
}

/** Kills `pid` and every process it started, at once. A gone process is fine. */
function killTree(pid: number | undefined, platform: NodeJS.Platform): void {
  if (pid === undefined) return;
  if (platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    // The minus sign kills the process group that `detached` made.
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group is gone already.
  }
}
