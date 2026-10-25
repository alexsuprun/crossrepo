import { basename, join } from "node:path";
import { type CommandUnit, type Ctx, codebaseDir } from "../../domain/ctx.ts";
import { parseProjectRecord } from "../../domain/project-record.ts";
import { XrError } from "../../errors/index.ts";
import {
  findProject,
  type ProjectEntry,
  projectEntries,
  toEntry,
} from "../../services/projects.ts";

/**
 * `xr project info [<project>]`: one project and which worktree folders exist.
 * Reads only: no lock, no git, never a picker.
 */
export const projectInfo: CommandUnit = {
  accepts: ["codebase", "project"],
  async run(ctx, args) {
    const { discovery, fs } = ctx;
    const codebase = codebaseDir(discovery);
    const [name] = args;
    const project =
      name !== undefined
        ? findProject(ctx, codebase, name, { lenient: true })
        : discovery.kind === "project"
          ? currentProject(ctx, discovery.dir)
          : missingProject(ctx, codebase);
    const folders = new Set(fs.listDirs(project.path));
    return {
      blocks: [
        {
          type: "project",
          project: project.name,
          branch: project.branch,
          path: { path: project.path },
          codebase: { path: codebase },
          created: project.created,
          repos: project.repos.map((repo) => ({
            repo,
            path: { path: join(project.path, repo) },
            present: folders.has(repo),
          })),
        },
      ],
    };
  },
};

/** The project of the project folder `dir`, from its own record. */
function currentProject(ctx: Ctx, dir: string): ProjectEntry {
  const file = join(dir, ".crossrepo", "project.yaml");
  const record = parseProjectRecord(ctx.fs.readText(file) ?? "");
  if ("problem" in record) {
    throw new XrError({
      code: "invalid-project-record",
      message: `The project record ${file} is not valid: ${record.problem}.`,
      hint: `Fix ${file}, then run the command again.`,
    });
  }
  return toEntry(basename(dir), dir, record);
}

/** `missing-argument` with the project names. `info` never opens a picker. */
function missingProject(ctx: Ctx, codebase: string): never {
  const choices = projectEntries(ctx, codebase, { lenient: true }).map(
    ({ name }) => name,
  );
  throw new XrError({
    code: "missing-argument",
    ...(choices.length
      ? {
          message: `Give the project to show. Projects: ${choices.join(", ")}.`,
          hint: "xr project info <project>",
        }
      : {
          message: "There is no project in this codebase.",
          hint: "Start one with `xr project create <branch> <repo>...`.",
        }),
    details: { argument: "project", choices },
  });
}
