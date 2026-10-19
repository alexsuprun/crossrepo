import { type CommandUnit, codebaseDir } from "../../../domain/ctx.ts";
import { transaction } from "../../../runners/transaction.ts";
import { removeName, removeRepo } from "../../../services/repo-remove.ts";

/** `xr codebase repo remove [name] [--keep-folder] [--force]`: removes one repo (D38, D45, D60, AD-17). */
export const codebaseRepoRemove: CommandUnit = {
  accepts: ["codebase"],
  async run(ctx, args, options = {}) {
    const codebase = codebaseDir(ctx.discovery);
    // Before the transaction, so no lock is held while the user picks.
    const name = await removeName(ctx, codebase, args);
    const { removed, folderDeleted } = await transaction(
      ctx,
      (tx) =>
        removeRepo(ctx, tx, codebase, name, {
          keepFolder: options.keepFolder === true,
          force: options.force === true,
        }),
      { lock: "start" },
    );
    return {
      blocks: [
        { type: "value", key: "removed", value: removed },
        { type: "value", key: "folderDeleted", value: folderDeleted },
      ],
    };
  },
};
