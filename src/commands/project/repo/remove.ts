import { type CommandUnit, codebaseDir } from "../../../domain/ctx.ts";
import type { Block } from "../../../domain/report.ts";
import { transaction } from "../../../runners/transaction.ts";
import {
  removeProjectRepos,
  repoRemoveNames,
} from "../../../services/project-repo-remove.ts";
import { targetProject } from "../../../services/projects.ts";

/** `xr project repo remove [<repo>...] [--project <project>] [--force] [--delete-branch]`: removes worktrees from a live project (D61). */
export const projectRepoRemove: CommandUnit = {
  accepts: ["codebase", "project"],
  async run(ctx, args, options = {}) {
    const codebase = codebaseDir(ctx.discovery);
    // Both pickers run before the transaction, so no lock is held while the user picks.
    const project = await targetProject(
      ctx,
      codebase,
      options.project as string | undefined,
      {
        message: "Pick the project to remove repos from",
        missing: "Give the project with `--project <project>`.",
        hint: "xr project repo remove <repo>... --project <project>",
      },
    );
    const names = await repoRemoveNames(ctx, project, args);
    const { projectDir, branch, repos, movedOut } = await transaction(
      ctx,
      (tx) =>
        removeProjectRepos(ctx, tx, codebase, project, names, {
          force: options.force === true,
          deleteBranch: options.deleteBranch === true,
        }),
      { lock: "start" },
    );
    const blocks: Block[] = [
      { type: "value", key: "project", value: { path: projectDir } },
      { type: "value", key: "branch", value: branch },
      { type: "repos", items: repos },
    ];
    if (movedOut) {
      blocks.push({
        type: "note",
        tone: "warn",
        text: [
          "Your shell is in a deleted folder. Run `cd ",
          { path: projectDir, homeOnly: true },
          "`.",
        ],
      });
    }
    return { blocks };
  },
};
