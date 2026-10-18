import { type CommandUnit, codebaseDir } from "../../domain/ctx.ts";
import { perRepo } from "../../runners/per-repo.ts";
import { CLONE_FAILED_HINT, cloneMissing } from "../../services/clone.ts";

/** `xr codebase clone`: clones each configured repo that is not on disk, one at a time (CAP-2). */
export const codebaseClone: CommandUnit = {
  accepts: ["codebase"],
  async run(ctx) {
    const codebase = codebaseDir(ctx.discovery);
    const results = await perRepo(
      ctx,
      ctx.config.repos,
      cloneMissing(ctx, codebase),
      { hint: CLONE_FAILED_HINT },
    );
    return { blocks: [{ type: "repos", items: results }] };
  },
};
