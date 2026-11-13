import { spawn } from "node:child_process";

/** One running process and its current folder, as `lsof` prints it (symlinks resolved). */
export interface ProcessCwd {
  pid: number;
  /** 0 when `lsof` gave none. */
  ppid: number;
  command: string;
  cwd: string;
}

/** The processes adapter, as `ctx.processes`. It only reads; it never signals a process. */
export interface Processes {
  /** The pid of this `xr` process. */
  readonly self: number;
  /**
   * Every process `lsof` can see, with its current folder, or `null` when xr
   * cannot tell (Windows, no `lsof`). An aborted `signal` stops `lsof` and fails.
   */
  cwds(signal?: AbortSignal): Promise<ProcessCwd[] | null>;
}

export interface CreateProcessesOptions {
  platform: NodeJS.Platform;
  /** Default `lsof`. */
  command?: string;
}

/** `-R` with `R` in the field list gives the ppid on Linux and macOS alike. */
const LSOF_ARGS = ["-a", "-d", "cwd", "-R", "-FpRcn"];

export function createProcesses({
  platform,
  command = "lsof",
}: CreateProcessesOptions): Processes {
  return {
    self: process.pid,
    cwds: (signal) =>
      platform === "win32"
        ? Promise.resolve(null)
        : runLsof(command, signal).then((text) =>
            text === null ? null : parseLsof(text),
          ),
  };
}

/**
 * The stdout of `lsof`, also when it exits non-zero (it exits 1 when it cannot
 * read some processes), or `null` when it is not installed.
 */
function runLsof(
  command: string,
  signal?: AbortSignal,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Stopped before lsof started."));
      return;
    }
    let stdout = "";
    // `lsof` lists itself; in the cwd of `xr` it would count as a program in a worktree.
    const child = spawn(command, LSOF_ARGS, {
      cwd: "/",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", (error) => {
      signal?.removeEventListener("abort", abort);
      if ((error as { code?: unknown }).code === "ENOENT") resolve(null);
      else reject(error);
    });
    child.on("close", () => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(new Error("lsof was stopped."));
      else resolve(stdout);
    });
  });
}

/**
 * Parses `lsof -F` output: `p` pid starts a process, then `R` ppid, `c`
 * command, `f` fd and `n` path. A process with no `n` line is left out.
 */
export function parseLsof(text: string): ProcessCwd[] {
  const list: ProcessCwd[] = [];
  let current: Partial<ProcessCwd> | undefined;
  const flush = () => {
    if (current?.pid !== undefined && current.cwd !== undefined) {
      list.push({
        pid: current.pid,
        ppid: current.ppid ?? 0,
        command: current.command ?? "",
        cwd: current.cwd,
      });
    }
  };
  for (const line of text.split(/\r?\n/)) {
    const value = line.slice(1);
    switch (line[0]) {
      case "p":
        flush();
        current = { pid: Number(value) };
        break;
      case "R":
        if (current) current.ppid = Number(value);
        break;
      case "c":
        if (current) current.command = value;
        break;
      case "n":
        if (current) current.cwd = value;
        break;
    }
  }
  flush();
  return list;
}
