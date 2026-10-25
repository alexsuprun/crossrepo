import { dirname, join, resolve } from "node:path";
import type { Ctx, Tx } from "../domain/ctx.ts";
import { PROJECT_LIST_HINT } from "../domain/hints.ts";
import {
  type NewProjectRecord,
  type ProjectRecord,
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

/** One project of a codebase with its full record. */
export interface ProjectEntry {
  /** The project folder name in `projects-dir`. */
  name: string;
  /** The absolute project folder. */
  path: string;
  branch: string;
  /** In record order. */
  repos: string[];
  /** Absent in an old record. */
  created?: string;
}

export interface ScanOptions {
  /** A broken record is a live `invalid-project-record` warning and is skipped, instead of an error. */
  lenient?: boolean;
}

type ScanCtx = Pick<Ctx, "fs" | "config" | "out">;

/**
 * Each folder directly in `projects-dir` with a `.crossrepo/project.yaml` whose
 * `codebase` is `codebase` (same `dev` and `ino`, D53), in name order. A record
 * whose `codebase` does not exist is not a match. A missing `projects-dir` has
 * no projects. A record `parseProjectRecord` refuses goes to `onProblem`.
 */
function scan(
  { fs, config }: Pick<Ctx, "fs" | "config">,
  codebase: string,
  requireBranch: boolean,
  onProblem: (problem: XrError) => void,
): { name: string; folder: string; record: ProjectRecord }[] {
  const dir = config.projectsDir.resolved;
  const self = fs.stat(codebase);
  if (!self || !fs.exists(dir)) return [];
  const found: { name: string; folder: string; record: ProjectRecord }[] = [];
  for (const name of fs.listDirs(dir)) {
    const folder = join(dir, name);
    const file = join(folder, ".crossrepo", "project.yaml");
    const text = fs.readText(file);
    if (text === undefined) continue;
    const record = parseProjectRecord(text, { requireBranch });
    if ("problem" in record) {
      onProblem(
        new XrError({
          code: "invalid-project-record",
          message: `The project record ${file} is not valid: ${record.problem}.`,
          hint: `Fix ${file}, or remove the project folder ${folder}, then run the command again.`,
        }),
      );
      continue;
    }
    const other = fs.stat(resolve(folder, record.codebase));
    if (other && other.dev === self.dev && other.ino === self.ino) {
      found.push({ name, folder, record });
    }
  }
  return found;
}

function throwProblem(problem: XrError): never {
  throw problem;
}

/**
 * The projects of `codebase` (see `scan`). A record with no `branch` is still a
 * project here, for old records. Throws `invalid-project-record`.
 */
export function codebaseProjects(
  ctx: Pick<Ctx, "fs" | "config">,
  codebase: string,
): Project[] {
  return scan(ctx, codebase, false, throwProblem).map(({ name, record }) => ({
    name,
    repos: record.repos,
  }));
}

/**
 * The projects of `codebase` with their full records, in name order (see
 * `scan`). A record that is not valid or has no `branch` throws
 * `invalid-project-record`, or with `lenient` is a live warning and is skipped.
 */
export function projectEntries(
  ctx: ScanCtx,
  codebase: string,
  { lenient = false }: ScanOptions = {},
): ProjectEntry[] {
  const onProblem = lenient
    ? ({ code, message, hint }: XrError) =>
        ctx.out.emit({ type: "warning", warning: { code, message, hint } })
    : throwProblem;
  return scan(ctx, codebase, true, onProblem).map(({ name, folder, record }) =>
    toEntry(name, folder, record),
  );
}

/** The entry of the project in `folder`, from its parsed record. `record.branch` must be set. */
export function toEntry(
  name: string,
  folder: string,
  { branch = "", repos, created }: ProjectRecord,
): ProjectEntry {
  return { name, path: folder, branch, repos, created };
}

/**
 * The project whose folder name is `name`, else the one whose record `branch`
 * is `name`. Throws `project-not-found`.
 */
export function findProject(
  ctx: ScanCtx,
  codebase: string,
  name: string,
  options: ScanOptions = {},
): ProjectEntry {
  const entries = projectEntries(ctx, codebase, options);
  const found =
    entries.find((entry) => entry.name === name) ??
    entries.find((entry) => entry.branch === name);
  if (found) return found;
  throw new XrError({
    code: "project-not-found",
    message: `No project \`${name}\` in this codebase.`,
    hint: `Run \`${PROJECT_LIST_HINT}\` to see the projects.`,
    details: { project: name },
  });
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
