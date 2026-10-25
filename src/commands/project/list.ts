import { type CommandUnit, codebaseDir } from "../../domain/ctx.ts";
import { projectEntries } from "../../services/projects.ts";

/** `xr project list`: the projects of the codebase with their repos. Reads only: no lock, no git. */
export const projectList: CommandUnit = {
  accepts: ["codebase", "project"],
  async run(ctx) {
    const entries = projectEntries(ctx, codebaseDir(ctx.discovery), {
      lenient: true,
    });
    return {
      blocks: [
        {
          type: "projects",
          items: entries.map(({ name, branch, path, repos, created }) => ({
            project: name,
            branch,
            path: { path },
            repos,
            created,
          })),
        },
        ...(entries.length
          ? []
          : [
              {
                type: "note" as const,
                tone: "muted" as const,
                text: "No projects. Start one with `xr project create <branch> <repo>...`",
              },
            ]),
      ],
    };
  },
};
