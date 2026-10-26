import { type CommandUnit, codebaseDir } from "../../../domain/ctx.ts";
import { transaction } from "../../../runners/transaction.ts";
import {
  addProjectRepos,
  repoAddNames,
} from "../../../services/project-repo-add.ts";
import { targetProject } from "../../../services/projects.ts";

/** `xr project repo add [<repo>...] [--project <project>]`: adds worktrees to a live project, all or nothing (D61). */
export const projectRepoAdd: CommandUnit = {
  accepts: ["codebase", "project"],
  async run(ctx, args, options = {}) {
    const codebase = codebaseDir(ctx.discovery);
    // Both pickers run before the transaction, so no lock is held while the user picks.
    const project = await targetProject(
      ctx,
      codebase,
      options.project as string | undefined,
      {
        message: "Pick the project to add repos to",
        missing: "Give the project with `--project <project>`.",
        hint: "xr project repo add <repo>... --project <project>",
      },
    );
    const names = await repoAddNames(ctx, codebase, project, args);
    const { projectDir, branch, repos } = await transaction(
      ctx,
      (tx) => addProjectRepos(ctx, tx, codebase, project, names),
      { lock: "start" },
    );
    return {
      blocks: [
        { type: "value", key: "project", value: { path: projectDir } },
        { type: "value", key: "branch", value: branch },
        { type: "repos", items: repos },
      ],
    };
  },
};
