import { readFileSync } from "node:fs";
import { writeFileAtomic } from "../../config/index.ts";
import { XrError } from "../../errors/index.ts";

/** Text file reads and atomic writes, as `ctx.fs`. */
export interface Fs {
  /** The file text, or `undefined` when the file does not exist. */
  readText(path: string): string | undefined;
  /** Writes through `writeFileAtomic`; a symlink is followed, never replaced. */
  writeText(path: string, text: string): void;
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
  };
}
