import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../config/index.ts";
import { XrError } from "../../errors/index.ts";

/** Text file reads, atomic writes and folder work, as `ctx.fs`. */
export interface Fs {
  /** The file text, or `undefined` when the file does not exist. */
  readText(path: string): string | undefined;
  /** Writes through `writeFileAtomic`; a symlink is followed, never replaced. */
  writeText(path: string, text: string): void;
  /** Makes one folder. Fails when it exists or its parent is missing. */
  mkdir(path: string): void;
  /**
   * Deletes a file or a whole folder, also read-only files such as git objects
   * on Windows. A missing path is not an error.
   */
  remove(path: string): void;
  /** The names of the folders directly in `path`, sorted. Symlinks are left out. */
  listDirs(path: string): string[];
  exists(path: string): boolean;
  /** The absolute path with every symlink resolved. Throws when the path is missing. */
  realpath(path: string): string;
  /** The device and inode of the path, symlinks followed, or `undefined` when it is missing. */
  stat(path: string): FileId | undefined;
}

/** Two paths are the same file or folder when both numbers are the same (D53). */
export interface FileId {
  dev: bigint;
  ino: bigint;
}

// Node retries EBUSY, EMFILE, ENFILE, ENOTEMPTY and EPERM, which Windows gives while a file is in use.
const RM_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 100,
} as const;

/** Builds `ctx.fs`. `platform` lets tests reach the Windows rename retry. */
export function createFs(platform: NodeJS.Platform = process.platform): Fs {
  return {
    readText(path) {
      try {
        return readFileSync(path, "utf8");
      } catch (error) {
        if ((error as { code?: unknown }).code === "ENOENT") return undefined;
        throw error;
      }
    },
    writeText(path, text) {
      try {
        writeFileAtomic(path, text, platform);
      } catch (error) {
        if ((error as { busy?: unknown }).busy === true) {
          throw new XrError({
            code: "file-busy",
            message: `Could not write ${path}: another program is using it.`,
            hint: `Close programs that use \`${path}\`, then run the command again.`,
          });
        }
        throw error;
      }
    },
    mkdir(path) {
      mkdirSync(path);
    },
    remove(path) {
      // Bun's rmSync on macOS can stop partway without an error, so check the result.
      for (let tries = 1; ; tries += 1) {
        removeOnce(path);
        if (!existsSync(path)) return;
        if (tries === REMOVE_TRIES) {
          throw new Error(
            `Could not delete ${path}: it still exists after ${REMOVE_TRIES} tries.`,
          );
        }
      }
    },
    listDirs(path) {
      return readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    },
    exists(path) {
      return existsSync(path);
    },
    realpath(path) {
      return realpathSync(path);
    },
    stat(path) {
      const stats = statSync(path, { bigint: true, throwIfNoEntry: false });
      return stats && { dev: stats.dev, ino: stats.ino };
    },
  };
}

const REMOVE_TRIES = 3;

function removeOnce(path: string): void {
  try {
    rmSync(path, RM_OPTIONS);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code !== "EPERM" && code !== "EACCES") throw error;
    // Windows does not delete a read-only file, and git makes its object files read-only.
    makeWritable(path);
    rmSync(path, RM_OPTIONS);
  }
}

/** Makes every file and folder under `path` writable. Symlinks are not followed. */
function makeWritable(path: string): void {
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (!stats || stats.isSymbolicLink()) return;
  chmodSync(path, stats.isDirectory() ? 0o777 : 0o666);
  if (!stats.isDirectory()) return;
  for (const name of readdirSync(path)) makeWritable(join(path, name));
}
