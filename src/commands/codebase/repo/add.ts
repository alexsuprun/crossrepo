import { type CommandUnit, codebaseDir } from "../../../domain/ctx.ts";
import { transaction } from "../../../runners/transaction.ts";
import {
  addRepo,
  parseSource,
  sourceArgs,
} from "../../../services/repo-add.ts";

/** `xr codebase repo add <url> [name]|<folder>`: clones or adopts one repo, or picks a folder (CAP-2, D31, D32, D38). */
export const codebaseRepoAdd: CommandUnit = {
  accepts: ["codebase"],
  async run(ctx, args) {
    const codebase = codebaseDir(ctx.discovery);
    // Before the transaction, so no lock is held while the user picks.
    const source = parseSource(ctx, await sourceArgs(ctx, codebase, args));
    const added = await transaction(
      ctx,
      (tx) => addRepo(ctx, tx, codebase, source),
      { lock: "start" },
    );
    return {
      blocks: [{ type: "table", key: "added", items: [{ ...added }] }],
    };
  },
};
