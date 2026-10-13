import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

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
 * Makes `<root>/<name>` repos with one commit. The origins are local bare repos
 * in `<root>-origins`, so no test uses the network (AD-13). Gives the origin
 * path of each repo that has one.
 */
export function makeRepos(
  root: string,
  spec: Record<string, RepoSpec>,
): Record<string, string | undefined> {
  const origins = `${root}-origins`;
  const remotes: Record<string, string | undefined> = {};
  for (const [
    name,
    { origin = true, head = true, branch = "main" },
  ] of Object.entries(spec)) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "--quiet", `--initial-branch=${branch}`);
    git(dir, "commit", "--quiet", "--allow-empty", "-m", "first");
    if (!origin) continue;
    const remote = join(origins, `${name}.git`);
    mkdirSync(remote, { recursive: true });
    git(remote, "init", "--quiet", "--bare", `--initial-branch=${branch}`);
    git(dir, "remote", "add", "origin", remote);
    git(dir, "push", "--quiet", "origin", branch);
    if (head) git(dir, "remote", "set-head", "origin", branch);
    remotes[name] = remote;
  }
  return remotes;
}
