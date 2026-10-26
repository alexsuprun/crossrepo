import { type CommandUnit, codebaseDir } from "../../domain/ctx.ts";
import type { Block } from "../../domain/report.ts";
import { XrError } from "../../errors/index.ts";
import { perRepo } from "../../runners/per-repo.ts";
import { SYNC_FAILED_HINT, syncRepo } from "../../services/project-sync.ts";
import { reloadProject, targetProject } from "../../services/projects.ts";

/**
 * `xr project sync [<project>]`: fetches `origin` and merges
 * `origin/<default branch>` into each worktree of one project, one repo at a
 * time under the codebase lock (D55). Runs no hook. A `failed` or `conflict`
 * repo fails the run with `repos-failed`.
 */
export const projectSync: CommandUnit = {
  accepts: ["codebase", "project"],
  async run(ctx, args) {
    const codebase = codebaseDir(ctx.discovery);
    const [name] = args;
    // The picker runs before `perRepo`, so no lock is held while the user picks.
    const target = await targetProject(ctx, codebase, name, {
      message: "Pick the project to sync",
      missing: "Give the project to sync.",
      hint: "xr project sync <project>",
    });
    let project = target;
    let sync: ReturnType<typeof syncRepo>;
    const head = (): Block[] => [
      { type: "value", key: "project", value: { path: project.path } },
      { type: "value", key: "branch", value: project.branch },
    ];
    try {
      const results = await perRepo(
        ctx,
        () => {
          // Read again inside the lock: the record may have changed while the user picked.
          project = reloadProject(ctx.fs, target);
          sync = syncRepo(ctx, codebase, project);
          return project.repos.map((repo) => ({ name: repo }));
        },
        (repo, signal) => sync(repo, signal),
        { hint: SYNC_FAILED_HINT },
      );
      return { blocks: [...head(), { type: "repos", items: results }] };
    } catch (error) {
      if (error instanceof XrError && error.report) {
        error.report = [...head(), ...error.report];
      }
      throw error;
    }
  },
};
