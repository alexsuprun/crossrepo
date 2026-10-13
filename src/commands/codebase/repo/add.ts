import { type CommandUnit, codebaseDir } from "../../../domain/ctx.ts";
import { transaction } from "../../../runners/transaction.ts";
import { addRepo, parseSource } from "../../../services/repo-add.ts";

/** `xr codebase repo add <url> [name]|<folder>`: clones or adopts one repo (CAP-2, D31, D32). */
export const codebaseRepoAdd: CommandUnit = {
  accepts: ["codebase"],
  async run(ctx, args) {
    const source = parseSource(ctx, args);
    const codebase = codebaseDir(ctx.discovery);
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
