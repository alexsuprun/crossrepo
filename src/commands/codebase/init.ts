import { join } from "node:path";
import type { CommandUnit } from "../../domain/ctx.ts";
import { XrError } from "../../errors/index.ts";
import { transaction } from "../../runners/transaction.ts";
import {
  checkRepos,
  writeCodebaseFiles,
} from "../../services/codebase-init.ts";

const ADD_HINT = "xr codebase repo add <url>|<folder>";

/** `xr codebase init`: makes the current folder a codebase of the repos in it (CAP-1). */
export const codebaseInit: CommandUnit = {
  accepts: ["none"],
  refuse(discovery, fs) {
    if (discovery.kind === "project") {
      return new XrError({
        code: "inside-a-project",
        message: `${discovery.dir} is a project, so it cannot be a codebase.`,
        hint: "Run `xr codebase init` in the folder that holds your repos.",
      });
    }
    const yml = join(discovery.dir, ".crossrepo", "config.yml");
    const yaml = join(discovery.dir, ".crossrepo", "config.yaml");
    const file =
      fs.exists(yml) && !fs.exists(yaml) ? "config.yml" : "config.yaml";
    return new XrError({
      code: "already-a-codebase",
      message: `${discovery.dir} is already a codebase.`,
      hint: `To add a repo, run \`${ADD_HINT}\`. To start again, delete \`.crossrepo/${file}\`, then run \`xr codebase init\`.`,
    });
  },
  async run(ctx) {
    const dir = ctx.discovery.dir;
    if (ctx.fs.exists(join(dir, ".crossrepo"))) {
      throw new XrError({
        code: "already-a-codebase",
        message: `${dir} has a .crossrepo/ folder with no config.`,
        hint: "If you do not need its files, delete `.crossrepo/`, then run `xr codebase init`.",
      });
    }
    const repos = await checkRepos(ctx, dir);
    await transaction(ctx, (tx) => writeCodebaseFiles(ctx, tx, dir, repos));
    return {
      blocks: [
        { type: "value", key: "codebase", value: { path: dir } },
        {
          type: "table",
          key: "added",
          items: repos.map(({ name, remote, defaultBranch }) => ({
            repo: name,
            remote,
            defaultBranch,
          })),
        },
        ...(repos.length
          ? []
          : [
              {
                type: "note" as const,
                tone: "muted" as const,
                text: `No repos found. Add one with \`${ADD_HINT}\`.`,
              },
            ]),
      ],
    };
  },
};
