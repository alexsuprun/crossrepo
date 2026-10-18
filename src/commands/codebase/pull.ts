import { type CommandUnit, codebaseDir } from "../../domain/ctx.ts";
import { perRepo } from "../../runners/per-repo.ts";
import { PULL_FAILED_HINT, pullPresent } from "../../services/pull.ts";

/** `xr codebase pull`: fast-forwards the checked-out branch of each repo on disk, one at a time (D35). */
export const codebasePull: CommandUnit = {
  accepts: ["codebase"],
  async run(ctx) {
    const codebase = codebaseDir(ctx.discovery);
    const results = await perRepo(
      ctx,
      ctx.config.repos,
      pullPresent(ctx, codebase),
      { hint: PULL_FAILED_HINT },
    );
    return { blocks: [{ type: "repos", items: results }] };
  },
};
