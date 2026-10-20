import { basename, dirname, join, resolve } from "node:path";
import {
  addRepoEntry,
  codebaseConfigName,
  codebaseRepos,
  repoKeys,
} from "../domain/codebase-config.ts";
import type { Ctx, Tx } from "../domain/ctx.ts";
import { XrError } from "../errors/index.ts";
import { writeCodebaseSection } from "./agents-md.ts";
import { checkRepo, type RepoProblem, reposNotReady } from "./codebase-init.ts";
import { repoFolders } from "./repos.ts";

/** What `xr codebase repo add` was asked to add. */
export type RepoSource =
  | { kind: "clone"; url: string; name: string }
  | { kind: "adopt"; dir: string; name: string };

/** One added repo, as the `added` table row. */
export interface AddedRepo {
  repo: string;
  remote: string;
  defaultBranch: string;
  description: string;
  cloned: boolean;
}

const USAGE_HINT = "Run `xr codebase repo add --help` for usage.";
const NOT_READY_HINT =
  "Run the fix for the repo, then run `xr codebase repo add` again.";

/**
 * The arguments as given, or, when none is given, the absolute path of the
 * folder picked from `addChoices` (D38). `ctx.cwd` can differ from the codebase.
 */
export async function sourceArgs(
  ctx: Pick<Ctx, "fs" | "config" | "prompt">,
  codebase: string,
  args: readonly (string | undefined)[],
): Promise<readonly (string | undefined)[]> {
  if (args[0] !== undefined) return args;
  const folder = await ctx.prompt.pick({
    argument: "folder",
    message: "Pick the folder to add",
    choices: addChoices(ctx, codebase),
    missing: "Give a git URL to clone, or a folder in the codebase to add.",
    listLabel: "Folders",
    hint: "xr codebase repo add <url> [name] | <folder>",
    empty: {
      message: "There is no folder to add.",
      hint: "xr codebase repo add <url> [name]",
    },
  });
  return [join(codebase, folder)];
}

/**
 * The folders `add` can adopt: child folders of the codebase with a `.git`
 * whose name is neither in the merged `repos` nor a key of the codebase file, sorted by name.
 */
export function addChoices(
  ctx: Pick<Ctx, "fs" | "config">,
  codebase: string,
): string[] {
  const taken = new Set([
    ...ctx.config.repos.map((repo) => repo.name),
    ...repoKeys(ctx.fs.readText(codebaseConfigPath(ctx.fs, codebase)) ?? ""),
  ]);
  return repoFolders(ctx.fs, codebase)
    .filter((name) => !taken.has(name))
    .sort();
}

/**
 * Reads `<url> [name]` or `<folder>`. The argument is a folder when that path
 * exists, resolved against `ctx.cwd`; otherwise it is a URL. Throws `usage`.
 */
export function parseSource(
  ctx: Pick<Ctx, "fs" | "cwd">,
  args: readonly (string | undefined)[],
): RepoSource {
  const [source, name] = args;
  if (!source) {
    throw usage("Give a git URL to clone, or a folder in the codebase to add.");
  }
  const dir = resolve(ctx.cwd, source);
  if (ctx.fs.exists(dir)) {
    if (name !== undefined) {
      throw usage(
        `\`${source}\` is a folder, so it takes no name: the repo name is the folder name.`,
      );
    }
    return { kind: "adopt", dir, name: checkName(basename(dir), "adopt") };
  }
  return {
    kind: "clone",
    url: source,
    name: checkName(name ?? nameOf(source), "clone"),
  };
}

/** The last part of a URL, split on `/`, `\` and `:`, without a trailing `/` and `.git`. */
export function nameOf(url: string): string {
  const last =
    url
      .replace(/[/\\]+$/, "")
      .split(/[/\\:]/)
      .pop() ?? "";
  return last.replace(/\.git$/, "");
}

function checkName(name: string, kind: RepoSource["kind"]): string {
  if (
    !name ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("..") ||
    name.startsWith(".")
  ) {
    throw new XrError({
      code: "usage",
      message: `\`${name}\` is not a valid repo name.`,
      hint: `A repo name is not empty, has no \`/\`, \`\\\` or \`..\`, and does not start with \`.\`. ${
        kind === "clone"
          ? "Give one with `xr codebase repo add <url> <name>`."
          : "Rename the folder, then run `xr codebase repo add <folder>` again."
      }`,
    });
  }
  return name;
}

function usage(message: string): XrError {
  return new XrError({ code: "usage", message, hint: USAGE_HINT });
}

/** The codebase config file in its own spelling: `config.yaml`, or `config.yml` when only it exists. */
export function codebaseConfigPath(fs: Ctx["fs"], codebase: string): string {
  const folder = join(codebase, ".crossrepo");
  return join(
    folder,
    codebaseConfigName((name) => fs.exists(join(folder, name))),
  );
}

/**
 * The checks and steps of `xr codebase repo add`, run inside a transaction that
 * holds the lock: the name and folder checks, the clone, the readiness check,
 * the config entry and the `## Codebase` section. An adopted folder is never deleted.
 */
export async function addRepo(
  ctx: Pick<Ctx, "fs" | "git" | "out" | "config">,
  tx: Tx,
  codebase: string,
  source: RepoSource,
): Promise<AddedRepo> {
  const { fs } = ctx;
  const { name } = source;
  const file = codebaseConfigPath(fs, codebase);
  const oldConfig = fs.readText(file);
  const target = join(codebase, name);
  checkFree(ctx, oldConfig ?? "", source, target);

  let repoDir = target;
  if (source.kind === "adopt") {
    checkInCodebase(fs, codebase, source.dir);
    repoDir = source.dir;
    if (!fs.exists(join(repoDir, ".git"))) {
      ctx.out.emit({
        type: "repo",
        repo: name,
        status: "failed",
        message: "not a repo",
      });
      throw notReady({
        repo: name,
        problem: "not a repo",
        fix: "Pick a folder with a `.git`, or clone the repo with `xr codebase repo add <url>`.",
      });
    }
  } else {
    await ctx.git.version();
    await tx.step(
      `Clone ${name}`,
      async (signal) => {
        // A folder that another program made after the check is not ours to delete.
        const existed = fs.exists(target);
        try {
          await ctx.git.clone(source.url, target, { signal });
        } catch (error) {
          // The step has no undo yet, so a partial clone goes here.
          if (!existed) {
            try {
              fs.remove(target);
            } catch {
              // The clone error is the one to report.
            }
          }
          throw error;
        }
      },
      () => fs.remove(target),
      { what: "cloned repo", path: target, command: `rm -r "${target}"` },
    );
  }

  const checked = await checkRepo(ctx, name, repoDir);
  if ("problem" in checked) throw notReady(checked);
  // A clone keeps the URL exactly as the user gave it (AD-6).
  const remote = source.kind === "clone" ? source.url : checked.remote;
  const { defaultBranch } = checked;

  const newConfig = addRepoEntry(oldConfig ?? "", {
    name,
    remote,
    defaultBranch,
  });
  await tx.step(
    `Write .crossrepo/${basename(file)}`,
    () => fs.writeText(file, newConfig),
    () =>
      oldConfig === undefined ? fs.remove(file) : fs.writeText(file, oldConfig),
    {
      what: "config file",
      path: file,
      command: `Remove the \`${name}\` entry from \`repos:\` by hand.`,
    },
  );

  const agents = join(codebase, "AGENTS.md");
  const isNew = fs.readText(agents) === undefined;
  await tx.step(
    "Write AGENTS.md",
    () =>
      // The codebase file only: a repo in `config.local` stays out of the shared AGENTS.md.
      writeCodebaseSection(fs, codebase, codebaseRepos(newConfig)),
    (old) =>
      old === undefined ? fs.remove(agents) : fs.writeText(agents, old),
    {
      what: "AGENTS.md",
      path: agents,
      command: isNew
        ? `rm "${agents}"`
        : `Remove \`${name}\` from the \`## Codebase\` section of AGENTS.md by hand.`,
    },
  );

  return {
    repo: name,
    remote,
    defaultBranch,
    description: "",
    cloned: source.kind === "clone",
  };
}

/** `repo-exists` when the name is taken in the merged config or the file, or the clone target exists. */
function checkFree(
  ctx: Pick<Ctx, "fs" | "config">,
  configText: string,
  source: RepoSource,
  target: string,
): void {
  const { name } = source;
  const taken =
    ctx.config.repos.some((repo) => repo.name === name) ||
    repoKeys(configText).includes(name);
  if (taken) {
    throw new XrError({
      code: "repo-exists",
      message: `The codebase already has a repo named \`${name}\`.`,
      hint:
        source.kind === "clone"
          ? "Give another name: `xr codebase repo add <url> <name>`. See the repos with `xr codebase repo list`."
          : "See the repos with `xr codebase repo list`.",
    });
  }
  if (source.kind === "clone" && ctx.fs.exists(target)) {
    throw new XrError({
      code: "repo-exists",
      message: `${target} already exists.`,
      hint: `To add the repo in that folder, run \`xr codebase repo add ./${name}\` in the codebase. Or give another name: \`xr codebase repo add <url> <name>\`.`,
    });
  }
}

/** `not-in-codebase` unless the real parent of `dir` is the real codebase folder. */
function checkInCodebase(fs: Ctx["fs"], codebase: string, dir: string): void {
  if (fs.realpath(dirname(dir)) === fs.realpath(codebase)) return;
  throw new XrError({
    code: "not-in-codebase",
    message: `${dir} is not directly in the codebase ${codebase}.`,
    hint: `Move the folder into ${codebase} first, then run \`xr codebase repo add <folder>\` again. To clone a local repo, give a \`file://\` URL.`,
  });
}

function notReady(problem: RepoProblem): XrError {
  return reposNotReady([problem], NOT_READY_HINT);
}
