import { basename, dirname, join, resolve } from "node:path";
import { type Ctx, codebaseDir, type Tx } from "../domain/ctx.ts";
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

/** The project of the project folder `dir`, from its own record. Throws `invalid-project-record`. */
export function currentProject(fs: Ctx["fs"], dir: string): ProjectEntry {
  const file = join(dir, ".crossrepo", "project.yaml");
  const record = parseProjectRecord(fs.readText(file) ?? "");
  if ("problem" in record) {
    throw new XrError({
      code: "invalid-project-record",
      message: `The project record ${file} is not valid: ${record.problem}.`,
      hint: `Fix ${file}, then run the command again.`,
    });
  }
  return toEntry(basename(dir), dir, record);
}

/** The texts of a project picker. */
export interface ProjectPick {
  /** The picker title. */
  message: string;
  /** The start of the `missing-argument` message. */
  missing: string;
  /** The usage hint of the `missing-argument` error. */
  hint: string;
}

/**
 * The project picked from the project folder names, with their branches as
 * hints. Not interactive, it throws `missing-argument` with the names.
 */
export async function pickProject(
  ctx: Pick<Ctx, "fs" | "config" | "out" | "prompt">,
  codebase: string,
  { message, missing, hint }: ProjectPick,
): Promise<ProjectEntry> {
  const entries = projectEntries(ctx, codebase, { lenient: true });
  const picked = await ctx.prompt.pick({
    argument: "project",
    message,
    choices: entries.map((entry) => entry.name),
    hints: Object.fromEntries(
      entries.map((entry) => [entry.name, entry.branch]),
    ),
    missing,
    listLabel: "Projects",
    hint,
    empty: {
      message: "There is no project in this codebase.",
      hint: "Start one with `xr project create <branch> <repo>...`.",
    },
  });
  return entries.find((entry) => entry.name === picked) as ProjectEntry;
}

/**
 * The project of a command that works on one project (D61): the one `name`
 * gives (folder name, else branch), else the project of the current project
 * folder, else the one picked. Runs before the transaction, so no lock is held
 * while the user picks. Changes nothing.
 */
export async function targetProject(
  ctx: Pick<Ctx, "fs" | "config" | "out" | "prompt" | "discovery">,
  codebase: string,
  name: string | undefined,
  pick: ProjectPick,
): Promise<ProjectEntry> {
  if (name !== undefined) {
    return findProject(ctx, codebase, name, { lenient: true });
  }
  if (ctx.discovery.kind === "project") {
    return currentProject(ctx.fs, ctx.discovery.dir);
  }
  return pickProject(ctx, codebase, pick);
}

/**
 * The folder of the project a doctor checks, in the order of `targetProject`,
 * but a project folder gives its own folder without reading the record, so a
 * broken record can still be checked. A name in a broken project folder
 * throws the discovery error: there is no codebase to search. Changes nothing.
 */
export async function doctorProjectDir(
  ctx: Pick<Ctx, "fs" | "config" | "out" | "prompt" | "discovery">,
  name: string | undefined,
  pick: ProjectPick,
): Promise<string> {
  const { discovery } = ctx;
  if (discovery.kind === "broken-project") {
    if (name !== undefined) throw discovery.error;
    return discovery.dir;
  }
  const codebase = codebaseDir(discovery);
  if (name !== undefined) {
    return findProject(ctx, codebase, name, { lenient: true }).path;
  }
  if (discovery.kind === "project") return discovery.dir;
  return (await pickProject(ctx, codebase, pick)).path;
}

/**
 * The project again, read inside the lock: its record may have changed or gone
 * while the user picked. Throws `project-not-found` when the record is gone.
 */
export function reloadProject(
  fs: Ctx["fs"],
  project: ProjectEntry,
): ProjectEntry {
  if (!fs.exists(join(project.path, ".crossrepo", "project.yaml"))) {
    throw new XrError({
      code: "project-not-found",
      message: `The project ${project.name} is gone.`,
      hint: `Run \`${PROJECT_LIST_HINT}\` to see the projects.`,
      details: { project: project.name },
    });
  }
  return currentProject(fs, project.path);
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
 * undo writes the old text back when the file existed, else removes the file,
 * and the `.crossrepo` folder when the step made it. `byHand` is the leftover
 * command for an existing file.
 */
export async function writeProjectRecordStep(
  fs: Ctx["fs"],
  tx: Tx,
  projectDir: string,
  record: NewProjectRecord,
  byHand?: string,
): Promise<void> {
  const folder = join(projectDir, ".crossrepo");
  const file = join(folder, "project.yaml");
  const madeFolder = !fs.exists(folder);
  const old = fs.readText(file);
  const made = madeFolder ? folder : file;
  await tx.step(
    "Write project record",
    () => {
      if (madeFolder) fs.mkdir(folder);
      fs.writeText(file, renderProjectRecord(record));
    },
    () => (old === undefined ? fs.remove(made) : fs.writeText(file, old)),
    old === undefined
      ? { what: "project record", path: made, command: `rm -rf "${made}"` }
      : {
          what: "project record",
          path: file,
          command: byHand ?? `Write the old text of ${file} back by hand.`,
        },
  );
}
