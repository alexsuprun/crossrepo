import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseVersion } from "../../src/adapters/git/index.ts";

/** How `makeRepos` sets up one repo. */
export interface RepoSpec {
  /** Add an `origin` remote. Default true. */
  origin?: boolean;
  /** Set `origin/HEAD`. Default true; needs `origin`. */
  head?: boolean;
  /** The branch of the first commit. Default `main`. */
  branch?: string;
}

/** Runs git in `cwd` with the test env and gives stdout; throws on failure. */
export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    // Bun 1.3.0 does not pass later process.env changes to a child without `env`.
    env: { ...process.env },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * The lines xr puts before a `git worktree repair` fix with the git on PATH:
 * a needs line on git older than 2.29, which has no `worktree repair`.
 */
export function repairNeeds(): string[] {
  const { stdout } = spawnSync("git", ["version"], { encoding: "utf8" });
  const version = parseVersion(stdout ?? "");
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 2 || (major === 2 && minor >= 29)
    ? []
    : [`needs git 2.29 or newer (you have ${version}):`];
}

/**
 * Makes `<root>/<name>` repos with one commit. The origins are local bare repos
 * in `<root>-origins`, so no test uses the network (AD-13). Gives the origin
 * path of each repo that has one.
 *
 * Each repo kind is made with git once, then copied: git starts are the
 * slowest part of the tests, most of all on Windows. So repos of the same kind
 * share their commit hashes.
 */
export function makeRepos(
  root: string,
  spec: Record<string, RepoSpec>,
): Record<string, string | undefined> {
  const origins = `${root}-origins`;
  const remotes: Record<string, string | undefined> = {};
  for (const [name, repoSpec] of Object.entries(spec)) {
    const template = repoTemplate(repoSpec);
    const dir = join(root, name);
    cpSync(template.repo, dir, { recursive: true });
    if (!template.origin) continue;
    const remote = join(origins, `${name}.git`);
    cpSync(template.origin, remote, { recursive: true });
    const config = join(dir, ".git", "config");
    const text = readFileSync(config, "utf8");
    const url = `url = ${configValue(template.origin)}\n`;
    if (!text.includes(url)) {
      throw new Error(`makeRepos: no origin url in ${config}`);
    }
    writeFileSync(config, text.replace(url, `url = ${configValue(remote)}\n`));
    remotes[name] = remote;
  }
  return remotes;
}

interface RepoTemplate {
  repo: string;
  origin?: string;
}

const templates = new Map<string, RepoTemplate>();
let templateRoot: string | undefined;

/** The folder of the repo templates, or undefined before the first `makeRepos`. */
export function repoTemplateRoot(): string | undefined {
  return templateRoot;
}

/** Deletes the repo templates; the preload runs it after all tests. */
export function removeRepoTemplates(): void {
  if (templateRoot) rmSync(templateRoot, { recursive: true, force: true });
  templateRoot = undefined;
  templates.clear();
}

/** The repo (and origin) of one kind, made with git on first use. */
function repoTemplate({
  origin = true,
  head = true,
  branch = "main",
}: RepoSpec): RepoTemplate {
  const key = JSON.stringify({ origin, head, branch });
  const known = templates.get(key);
  if (known) return known;
  templateRoot ??= mkdtempSync(join(tmpdir(), "xr-repo-templates-"));
  // A new folder each time, so a build that failed half way leaves nothing in the way.
  const base = mkdtempSync(join(templateRoot, "kind-"));
  const repo = join(base, "repo");
  mkdirSync(repo);
  // Not `init --initial-branch`: it needs git 2.28, and the floor is 2.27.
  git(repo, "init", "--quiet");
  git(repo, "symbolic-ref", "HEAD", `refs/heads/${branch}`);
  // No background git may write into a template while it is copied: git runs
  // auto maintenance in the background after a commit, and auto gc after a push.
  git(
    repo,
    ...["-c", "maintenance.auto=false", "-c", "gc.auto=0"],
    ...["commit", "--quiet", "--allow-empty", "-m", "first"],
  );
  const template: RepoTemplate = { repo };
  if (origin) {
    // The origin is a bare copy of the repo's .git, so no push runs.
    const remote = join(base, "origin.git");
    cpSync(join(repo, ".git"), remote, { recursive: true });
    rmSync(join(remote, "index"));
    const config = join(remote, "config");
    const text = readFileSync(config, "utf8");
    if (!text.includes("bare = false")) {
      throw new Error(`makeRepos: no bare setting in ${config}`);
    }
    writeFileSync(config, text.replace("bare = false", "bare = true"));
    git(repo, "remote", "add", "origin", remote);
    git(repo, "update-ref", `refs/remotes/origin/${branch}`, "HEAD");
    if (head) git(repo, "remote", "set-head", "origin", branch);
    template.origin = remote;
  }
  templates.set(key, template);
  return template;
}

/** A value as git writes it to a config file: `\` and `"` escaped. */
function configValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

let pushes = 0;

/**
 * Pushes one new commit to `branch` of the bare repo `origin`, made in a new
 * clone next to it. With `file`, the commit adds or changes that file; else it
 * is empty. Gives the hash of the new commit.
 */
export function pushCommit(
  origin: string,
  { branch = "main", file }: { branch?: string; file?: string } = {},
): string {
  const work = mkdtempSync(join(dirname(origin), "work-"));
  git(work, "clone", "--quiet", "--branch", branch, origin, ".");
  if (file) {
    pushes += 1;
    writeFileSync(join(work, file), `from origin ${pushes}\n`);
    git(work, "add", "--", file);
    git(work, "commit", "--quiet", "-m", `add ${file}`);
  } else {
    git(work, "commit", "--quiet", "--allow-empty", "-m", "from origin");
  }
  git(work, "push", "--quiet", "origin", branch);
  return git(work, "rev-parse", "HEAD").trim();
}
