import { join } from "node:path";
import type { ConfigRepoView, Ctx, RepoResult } from "../domain/ctx.ts";

/** One configured repo and what is on disk for it. */
export interface RepoState extends ConfigRepoView {
  /** `<codebase>/<name>/.git` exists, as a file or a folder. */
  present: boolean;
  /** `<codebase>/<name>` exists but has no `.git`, so `clone` cannot use it. */
  folderWithoutGit: boolean;
}

/** The merged repos of the codebase, in config order, with their state on disk. Reads only. */
export function repoStates(
  ctx: Pick<Ctx, "fs" | "config">,
  codebase: string,
): RepoState[] {
  return ctx.config.repos.map((repo) => repoState(ctx.fs, codebase, repo));
}

/** One configured repo with its state on disk now. Reads only. */
export function repoState(
  fs: Ctx["fs"],
  codebase: string,
  repo: ConfigRepoView,
): RepoState {
  const dir = join(codebase, repo.name);
  const present = fs.exists(join(dir, ".git"));
  return {
    ...repo,
    present,
    folderWithoutGit: !present && fs.exists(dir),
  };
}

/** The `failed` result of a repo whose folder has no `.git`, with the hint to move or delete it. */
export function folderWithoutGitResult(
  codebase: string,
  name: string,
): RepoResult {
  return {
    repo: name,
    status: "failed",
    message: "folder has no .git",
    hint: `Move or delete ${join(codebase, name)}, then run \`xr codebase clone\` again.`,
  };
}
