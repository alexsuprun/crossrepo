import { type CommandUnit, codebaseDir } from "../../../domain/ctx.ts";
import { ADD_HINT } from "../../../domain/hints.ts";
import type { Block } from "../../../domain/report.ts";
import { repoStates } from "../../../services/repos.ts";

/** `xr codebase repo list`: the merged repos and which are on disk (CAP-2). Reads only. */
export const codebaseRepoList: CommandUnit = {
  accepts: ["codebase", "project"],
  async run(ctx) {
    const { discovery } = ctx;
    const codebase = codebaseDir(discovery);
    const repos = repoStates(ctx, codebase);
    const table: Block = {
      type: "table",
      key: "entries",
      items: repos.map((repo) => ({
        repo: repo.name,
        remote: repo.remote ?? "",
        defaultBranch: repo.defaultBranch ?? "",
        description: repo.description ?? "",
        present: repo.present,
      })),
    };
    if (!repos.length) {
      return {
        blocks: [
          table,
          note(`The codebase has no repos. Add one with \`${ADD_HINT}\`.`),
        ],
      };
    }
    const missing = repos.some(
      (repo) => !repo.present && !repo.folderWithoutGit,
    );
    return {
      blocks: [
        table,
        ...(missing
          ? [note("Clone the missing repos with `xr codebase clone`.")]
          : []),
        ...repos
          .filter((repo) => repo.folderWithoutGit)
          .map((repo) =>
            note(
              `The folder \`${repo.name}\` has no \`.git\`, so \`xr codebase clone\` cannot use it. Move or delete it.`,
            ),
          ),
      ],
    };
  },
};

function note(text: string): Block {
  return { type: "note", tone: "muted", text };
}
