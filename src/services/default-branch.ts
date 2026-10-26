import type { Ctx } from "../domain/ctx.ts";
import { XrError } from "../errors/index.ts";

/**
 * The default branch of `repo` (AD-16): config `default-branch`, else
 * `origin/HEAD` of the repo at `dir`, else `no-default-branch`. Reads only.
 */
export async function defaultBranch(
  ctx: Pick<Ctx, "config" | "git">,
  repo: string,
  dir: string,
  signal: AbortSignal,
): Promise<string> {
  const configured = ctx.config.repos.find(
    (entry) => entry.name === repo,
  )?.defaultBranch;
  const found = configured ?? (await ctx.git.originHead(dir, { signal }));
  if (found) return found;
  throw new XrError({
    code: "no-default-branch",
    message: `\`${repo}\` has no default branch: the config has no \`default-branch\` for it, and \`origin/HEAD\` is not set.`,
    hint: `Run \`git -C "${dir}" remote set-head origin --auto\`, or set \`default-branch\` of \`${repo}\` in the config, then run the command again.`,
    details: { repo },
  });
}
