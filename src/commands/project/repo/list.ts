import { join } from "node:path";
import { type CommandUnit, codebaseDir } from "../../../domain/ctx.ts";
import { targetProject } from "../../../services/projects.ts";

/**
 * `xr project repo list [--project <project>]`: the repos of one project, with
 * whether each worktree folder exists. Reads only: no lock, no git.
 */
export const projectRepoList: CommandUnit = {
  accepts: ["codebase", "project"],
  async run(ctx, _args, options = {}) {
    const codebase = codebaseDir(ctx.discovery);
    const project = await targetProject(
      ctx,
      codebase,
      options.project as string | undefined,
      {
        message: "Pick the project to list",
        missing: "Give the project with `--project <project>`.",
        hint: "xr project repo list --project <project>",
      },
    );
    const folders = new Set(ctx.fs.listDirs(project.path));
    const descriptions = new Map(
      ctx.config.repos.map(({ name, description }) => [name, description]),
    );
    return {
      blocks: [
        {
          type: "project-repos",
          project: project.name,
          entries: project.repos.map((repo) => ({
            repo,
            path: { path: join(project.path, repo) },
            present: folders.has(repo),
            description: descriptions.get(repo),
          })),
        },
      ],
    };
  },
};
