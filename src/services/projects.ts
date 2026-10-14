import { join, resolve } from "node:path";
import type { Ctx } from "../domain/ctx.ts";
import { parseProjectRecord } from "../domain/project-record.ts";
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
    const record = parseProjectRecord(text);
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
