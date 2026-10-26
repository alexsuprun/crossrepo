import { type CommandUnit, codebaseDir } from "../../domain/ctx.ts";
import type { Block } from "../../domain/report.ts";
import { transaction } from "../../runners/transaction.ts";
import { rejectReservedVars } from "../../services/doctor-checks.ts";
import { removeProject, removeTarget } from "../../services/project-remove.ts";

/** `xr project remove [<project>] [--force] [--delete-branch]`: deletes the worktrees and the project folder (D36, AD-17). */
export const projectRemove: CommandUnit = {
  accepts: ["codebase", "project"],
  async run(ctx, args, options = {}) {
    const codebase = codebaseDir(ctx.discovery);
    rejectReservedVars(ctx.config);
    // Before the transaction, so no lock is held while the user picks.
    const project = await removeTarget(ctx, codebase, args);
    const { projectDir, branch, repos, movedOut } = await transaction(
      ctx,
      (tx) =>
        removeProject(ctx, tx, codebase, project, {
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
          { path: codebase, homeOnly: true },
          "`.",
        ],
      });
    }
    return { blocks };
  },
};
