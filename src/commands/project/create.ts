import { type CommandUnit, codebaseDir } from "../../domain/ctx.ts";
import { transaction } from "../../runners/transaction.ts";
import { rejectReservedVars } from "../../services/doctor-checks.ts";
import { createPlan, createProject } from "../../services/project-create.ts";

/** `xr project create <branch> [<repo>...|--all]`: one folder with a worktree of each chosen repo (D37, AD-11). */
export const projectCreate: CommandUnit = {
  accepts: ["codebase"],
  async run(ctx, args, options = {}) {
    const codebase = codebaseDir(ctx.discovery);
    rejectReservedVars(ctx.config);
    // Before the transaction, so no lock is held while the user picks.
    const plan = await createPlan(ctx, codebase, args, {
      all: options.all === true,
    });
    const { projectDir, branch, repos } = await transaction(
      ctx,
      (tx) => createProject(ctx, tx, codebase, plan),
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
