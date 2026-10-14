import { basename, join } from "node:path";
import {
  codebaseRepos,
  removeRepoEntry,
  repoKeys,
} from "../domain/codebase-config.ts";
import type { Ctx, Tx } from "../domain/ctx.ts";
import { LIST_HINT } from "../domain/hints.ts";
import { XrError } from "../errors/index.ts";
import { writeCodebaseSection } from "./agents-md.ts";
import { codebaseProjects } from "./projects.ts";
import { codebaseConfigPath } from "./repo-add.ts";

/** The flags of `xr codebase repo remove`. */
export interface RemoveOptions {
  /** Remove the entry only; skips the loss check. */
  keepFolder: boolean;
  /** Skip the loss check only (D45). */
  force: boolean;
}

/** What `xr codebase repo remove` did. */
export interface RemovedRepo {
  removed: string;
  folderDeleted: boolean;
}

type Loss = Awaited<ReturnType<Ctx["git"]["lossCheck"]>>;

/** The most uncommitted file names the `would-lose-work` message shows. */
const SHOWN_FILES = 5;

/** Reads `<name>`. Throws `usage` when it is missing. */
export function parseRemoveName(args: readonly (string | undefined)[]): string {
  const [name] = args;
  if (!name) {
    throw new XrError({
      code: "usage",
      message: "Give the name of the repo to remove.",
      hint: `Run \`xr codebase repo remove --help\` for usage. See the repos with \`${LIST_HINT}\`.`,
    });
  }
  return name;
}

/**
 * The check phase and the delete phase of `xr codebase repo remove`, run inside
 * a transaction that holds the lock. The checks change nothing: the name is a
 * key of the codebase file's `repos:`, no project of this codebase uses it, and
 * the folder has no work to lose. Then the `tx.finals` steps write the config,
 * write `## Codebase`, and delete the folder last (AD-17).
 */
export async function removeRepo(
  ctx: Pick<Ctx, "fs" | "git" | "config">,
  tx: Tx,
  codebase: string,
  name: string,
  { keepFolder, force }: RemoveOptions,
): Promise<RemovedRepo> {
  const { fs } = ctx;
  const file = codebaseConfigPath(fs, codebase);
  const oldConfig = fs.readText(file) ?? "";
  checkKnown(ctx, oldConfig, name);
  checkNotInUse(ctx, codebase, name);

  const dir = join(codebase, name);
  // A key such as `..` or `a/b` is never a folder of the codebase, so nothing is deleted for it.
  const deleteFolder = !keepFolder && isFolderName(name) && fs.exists(dir);
  if (deleteFolder) {
    if (!fs.exists(join(dir, ".git"))) throw notARepo(name, dir);
    if (!force) {
      const loss = await ctx.git.lossCheck(dir, { signal: tx.signal });
      if (hasLoss(loss)) throw wouldLoseWork(name, dir, loss);
    }
  }

  const newConfig = removeRepoEntry(oldConfig, name);
  const agents = join(codebase, "AGENTS.md");
  await tx.finals([
    {
      label: `Write .crossrepo/${basename(file)}`,
      run: () => fs.writeText(file, newConfig),
      manualCleanup: {
        what: "config file",
        path: file,
        command: `Remove the \`${name}\` entry from \`repos:\` in ${file} by hand.`,
      },
    },
    {
      label: "Write AGENTS.md",
      // The codebase file only: a repo in `config.local` stays out of the shared AGENTS.md.
      run: () => writeCodebaseSection(fs, codebase, codebaseRepos(newConfig)),
      manualCleanup: {
        what: "AGENTS.md",
        path: agents,
        command: `Run \`${LIST_HINT}\`, then remove \`${name}\` from the \`## Codebase\` section of AGENTS.md by hand.`,
      },
    },
    ...(deleteFolder
      ? [
          {
            label: `Delete ${name}/`,
            run: () => fs.remove(dir),
            manualCleanup: {
              what: "repo folder",
              path: dir,
              command: `rm -rf "${dir}"`,
            },
          },
        ]
      : []),
  ]);
  return { removed: name, folderDeleted: deleteFolder };
}

/** `repo-not-found` unless `name` is a key of the codebase file's `repos:`. */
function checkKnown(
  ctx: Pick<Ctx, "config">,
  configText: string,
  name: string,
): void {
  if (repoKeys(configText).includes(name)) return;
  const local = ctx.config.repos.some((repo) => repo.name === name);
  throw new XrError({
    code: "repo-not-found",
    message: `The codebase config has no repo named \`${name}\`.`,
    hint: local
      ? `\`${name}\` is only in config.local, which xr never edits: remove it there by hand. See the repos with \`${LIST_HINT}\`.`
      : `See the repos with \`${LIST_HINT}\`.`,
  });
}

/** `repo-in-use` when a project of this codebase has the repo. No flag skips it (D45). */
function checkNotInUse(
  ctx: Pick<Ctx, "fs" | "config">,
  codebase: string,
  name: string,
): void {
  const projects = codebaseProjects(ctx, codebase)
    .filter((project) => project.repos.includes(name))
    .map((project) => project.name);
  if (!projects.length) return;
  throw new XrError({
    code: "repo-in-use",
    message: `\`${name}\` is used by ${projects.length === 1 ? "the project" : "the projects"} ${projects.join(", ")}.`,
    hint: `Remove \`${name}\` from ${projects.length === 1 ? "that project" : "those projects"}, or remove the ${projects.length === 1 ? "project" : "projects"}, then run the command again.`,
    details: { projects },
  });
}

function isFolderName(name: string): boolean {
  return (
    name !== "" &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\")
  );
}

function hasLoss({ uncommitted, unpushed, stashes }: Loss): boolean {
  return uncommitted.length > 0 || unpushed.length > 0 || stashes > 0;
}

/** A folder with no `.git` is never deleted, also with `--force`. */
function notARepo(name: string, dir: string): XrError {
  return new XrError({
    code: "would-lose-work",
    message: `${dir} has no \`.git\`, so git cannot check it for work that a delete would lose.`,
    hint: `Run \`xr codebase repo remove ${name} --keep-folder\` to remove only the entry and keep the folder.`,
  });
}

function wouldLoseWork(name: string, dir: string, loss: Loss): XrError {
  const git = (command: string) => `\`git -C "${dir}" ${command}\``;
  const lines: string[] = [];
  const { uncommitted, unpushed, stashes } = loss;
  if (uncommitted.length) {
    const shown = uncommitted.slice(0, SHOWN_FILES).join(", ");
    const more =
      uncommitted.length > SHOWN_FILES
        ? ` and ${uncommitted.length - SHOWN_FILES} more`
        : "";
    lines.push(
      `${count(uncommitted.length, "uncommitted file")} (${shown}${more}): commit with ${git("commit")}`,
    );
  }
  if (unpushed.length) {
    const branches = unpushed
      .map(({ branch, count: n }) => `${count(n, "commit")} on ${branch}`)
      .join(", ");
    lines.push(`${branches}, on no remote: push with ${git("push")}`);
  }
  if (stashes > 0) {
    lines.push(
      `${count(stashes, "stash", "stashes")}: see with ${git("stash list")}`,
    );
  }
  return new XrError({
    code: "would-lose-work",
    message: [
      `Deleting ${dir} would lose work that is only there:`,
      ...lines.map((line) => `  ${line}`),
    ].join("\n"),
    hint: `Keep the work first, then run the command again. Or run \`xr codebase repo remove ${name} --keep-folder\` to keep the folder, or \`--force\` to delete it anyway.`,
    details: { uncommitted, unpushed, stashes },
  });
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
