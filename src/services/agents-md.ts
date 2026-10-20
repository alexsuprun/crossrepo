import { join } from "node:path";
import {
  type CodebaseRepo,
  detectEol,
  findSections,
  type ProjectRepo,
  projectReposSection,
  renderCodebaseSection,
  renderProjectCodebaseSection,
  spliceProjectSections,
  spliceSection,
} from "../domain/agents-md.ts";
import type { ConfigRepoView, Ctx, Tx } from "../domain/ctx.ts";

/** What the project `AGENTS.md` is made from. */
export interface ProjectAgentsInput {
  projectDir: string;
  codebaseDir: string;
  branch: string;
  /** The project repo names. */
  repos: readonly string[];
  /** The merged config repos (`ctx.config.repos`), which give the order and the descriptions. */
  configRepos: readonly ConfigRepoView[];
}

/**
 * The text of `<codebaseDir>/AGENTS.md` with the `## Codebase` section made
 * from `repos`, and the rest of the file as it is.
 */
export function codebaseAgentsText(
  fs: Ctx["fs"],
  codebaseDir: string,
  repos: readonly CodebaseRepo[],
): string {
  const text = fs.readText(join(codebaseDir, "AGENTS.md")) ?? "";
  return spliceSection(
    text,
    findSections(text).codebase,
    renderCodebaseSection(repos, detectEol(text)),
  );
}

/**
 * The text of the project `AGENTS.md`: the existing project file, else the
 * codebase file, else empty text, with only `## Codebase` and `## Repos`
 * changed. `## Repos` always comes from the current codebase file.
 */
export function projectAgentsText(
  fs: Ctx["fs"],
  input: ProjectAgentsInput,
): string {
  const { projectDir, codebaseDir, branch, repos, configRepos } = input;
  const codebaseText = fs.readText(join(codebaseDir, "AGENTS.md"));
  const base = fs.readText(join(projectDir, "AGENTS.md")) ?? codebaseText ?? "";
  const eol = detectEol(base);
  const wanted = new Set(repos);
  const inConfig = configRepos.filter((repo) => wanted.has(repo.name));
  const known = new Set(inConfig.map((repo) => repo.name));
  const ordered: ProjectRepo[] = [
    ...inConfig.map(({ name, description }) => ({ name, description })),
    ...[...wanted].filter((name) => !known.has(name)).map((name) => ({ name })),
  ].map((repo) => ({
    ...repo,
    instructions: instructionsOf(fs, join(projectDir, repo.name)),
  }));
  return spliceProjectSections(
    base,
    renderProjectCodebaseSection(branch, ordered, eol),
    projectReposSection(codebaseText ?? "", repos, eol),
  );
}

/**
 * Writes `text` to `path` when it differs from the file. Returns the old text,
 * or `undefined` when the file did not exist, so a caller can undo.
 */
export function writeAgentsText(
  fs: Ctx["fs"],
  path: string,
  text: string,
): string | undefined {
  const old = fs.readText(path);
  if (text !== old) fs.writeText(path, text);
  return old;
}

/**
 * The one "Write AGENTS.md" transaction step. Undo writes the old text back,
 * or removes the file when the step made it. A failed undo lists `rm "<path>"`
 * for a new file, else `byHand`.
 */
export async function writeAgentsStep(
  fs: Ctx["fs"],
  tx: Tx,
  path: string,
  text: string,
  byHand: string,
): Promise<void> {
  // The leftover goes to `tx.step` before `run`, so the file is read here first.
  const isNew = fs.readText(path) === undefined;
  await tx.step(
    "Write AGENTS.md",
    () => writeAgentsText(fs, path, text),
    (old) => (old === undefined ? fs.remove(path) : fs.writeText(path, old)),
    {
      what: "AGENTS.md",
      path,
      command: isNew ? `rm "${path}"` : byHand,
    },
  );
}

function instructionsOf(
  fs: Ctx["fs"],
  worktree: string,
): ProjectRepo["instructions"] {
  if (fs.exists(join(worktree, "AGENTS.md"))) return "AGENTS.md";
  if (fs.exists(join(worktree, "CLAUDE.md"))) return "CLAUDE.md";
  return undefined;
}
