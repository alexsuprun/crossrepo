import { dirname, join, resolve } from "node:path";
import type { Ctx, Tx } from "../domain/ctx.ts";
import {
  type NewProjectRecord,
  parseProjectRecord,
  renderProjectRecord,
} from "../domain/project-record.ts";
import { XrError } from "../errors/index.ts";

/** One project of a codebase, as its record gives it. */
export interface Project {
  /** The project folder name in `projects-dir`. */
  name: string;
  repos: string[];
}

/**
 * The projects of `codebase`: each folder directly in `projects-dir` with a
 * `.crossrepo/project.yaml` whose `codebase` is the same folder (same `dev` and
 * `ino`, D53). A record whose `codebase` does not exist is not a match. A
 * missing `projects-dir` folder has no projects. Throws `invalid-project-record`.
 */
export function codebaseProjects(
  ctx: Pick<Ctx, "fs" | "config">,
  codebase: string,
): Project[] {
  const { fs } = ctx;
  const dir = ctx.config.projectsDir.resolved;
  const self = fs.stat(codebase);
  if (!self || !fs.exists(dir)) return [];
  const projects: Project[] = [];
  for (const name of fs.listDirs(dir)) {
    const folder = join(dir, name);
    const file = join(folder, ".crossrepo", "project.yaml");
    const text = fs.readText(file);
    if (text === undefined) continue;
    // A record from before `branch` was written is still a project here.
    const record = parseProjectRecord(text, { requireBranch: false });
    if ("problem" in record) {
      throw new XrError({
        code: "invalid-project-record",
        message: `The project record ${file} is not valid: ${record.problem}.`,
        hint: `Fix ${file}, or remove the project folder ${folder}, then run the command again.`,
      });
    }
    const other = fs.stat(resolve(folder, record.codebase));
    if (other && other.dev === self.dev && other.ino === self.ino) {
      projects.push({ name, repos: record.repos });
    }
  }
  return projects;
}

/**
 * The "Make project folder" step: makes each missing parent of `projectDir`,
 * then `projectDir`, from the top down. The undo removes only the folders it
 * made, the deepest first.
 */
export async function makeProjectFolderStep(
  fs: Ctx["fs"],
  tx: Tx,
  projectDir: string,
): Promise<void> {
  const missing: string[] = [];
  for (
    let dir = projectDir;
    !fs.exists(dir) && dirname(dir) !== dir;
    dir = dirname(dir)
  ) {
    missing.unshift(dir);
  }
  const top = missing[0] ?? projectDir;
  await tx.step(
    "Make project folder",
    () => {
      const made: string[] = [];
      try {
        for (const dir of missing) {
          fs.mkdir(dir);
          made.push(dir);
        }
      } catch (error) {
        for (const dir of made.reverse()) fs.remove(dir);
        throw error;
      }
      return made;
    },
    (made) => {
      for (const dir of [...made].reverse()) fs.remove(dir);
    },
    { what: "project folder", path: top, command: `rm -rf "${top}"` },
  );
}

/**
 * The "Write project record" step: `<projectDir>/.crossrepo/project.yaml`. The
 * undo removes the file, and the `.crossrepo` folder when the step made it.
 */
export async function writeProjectRecordStep(
  fs: Ctx["fs"],
  tx: Tx,
  projectDir: string,
  record: NewProjectRecord,
): Promise<void> {
  const folder = join(projectDir, ".crossrepo");
  const file = join(folder, "project.yaml");
  const madeFolder = !fs.exists(folder);
  await tx.step(
    "Write project record",
    () => {
      if (madeFolder) fs.mkdir(folder);
      fs.writeText(file, renderProjectRecord(record));
    },
    () => fs.remove(madeFolder ? folder : file),
    {
      what: "project record",
      path: madeFolder ? folder : file,
      command: `rm -rf "${madeFolder ? folder : file}"`,
    },
  );
}
