import * as fs from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** Rename errors that Windows gives while another program holds the file. */
const BUSY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
/** Waits in ms between Windows rename attempts; about 1 s in total. */
const RETRY_DELAYS = [10, 20, 50, 100, 200, 300, 400];
const MAX_LINKS = 40;

/**
 * Writes `text` to `path` through a temp file in the real folder and a rename,
 * so a reader never sees half a file. A symlink is followed and never replaced.
 * On Windows a busy rename is retried; when it gives up, the thrown error keeps
 * the errno `code` and has `busy: true` and `path`.
 */
export function writeFileAtomic(
  path: string,
  text: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const target = realTarget(path);
  const mode = modeOf(target);
  const temp = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(temp, text, { flag: "wx", mode: mode ?? 0o666 });
    if (mode !== undefined) fs.chmodSync(temp, mode);
    renameWithRetry(temp, target, platform === "win32");
  } catch (error) {
    // EEXIST: `wx` found a file that is not ours, so it must stay.
    if (codeOf(error) !== "EEXIST") fs.rmSync(temp, { force: true });
    throw error;
  }
}

/** The real path to write: the link target for a symlink, the real folder for a new file. */
function realTarget(path: string): string {
  let current = resolve(path);
  for (let hop = 0; hop < MAX_LINKS; hop += 1) {
    try {
      return fs.realpathSync(current);
    } catch (error) {
      if (codeOf(error) !== "ENOENT") throw error;
    }
    const link = readLink(current);
    if (link === undefined) {
      return join(fs.realpathSync(dirname(current)), basename(current));
    }
    current = resolve(dirname(current), link);
  }
  throw Object.assign(new Error(`Too many symlinks at ${path}.`), {
    code: "ELOOP",
  });
}

function readLink(path: string): string | undefined {
  try {
    return fs.readlinkSync(path);
  } catch {
    return undefined;
  }
}

function modeOf(path: string): number | undefined {
  try {
    return fs.statSync(path).mode & 0o7777;
  } catch (error) {
    if (codeOf(error) === "ENOENT") return undefined;
    throw error;
  }
}

function renameWithRetry(from: string, to: string, retry: boolean): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = codeOf(error);
      if (!retry || code === undefined || !BUSY_CODES.has(code)) throw error;
      const delay = RETRY_DELAYS[attempt];
      if (delay === undefined) {
        throw Object.assign(
          new Error(`${to} is in use by another program.`, { cause: error }),
          { code, busy: true, path: to },
        );
      }
      sleep(delay);
    }
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}
