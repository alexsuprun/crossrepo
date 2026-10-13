import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
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
  /** Deletes a file or a whole folder. A missing path is not an error. */
  remove(path: string): void;
  /** The names of the folders directly in `path`, sorted. Symlinks are left out. */
  listDirs(path: string): string[];
  exists(path: string): boolean;
  /** The absolute path with every symlink resolved. Throws when the path is missing. */
  realpath(path: string): string;
}

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
      rmSync(path, { recursive: true, force: true });
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
  };
}
