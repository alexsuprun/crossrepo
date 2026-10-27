/**
 * The success signal (NFR12) on an installed xr: `codebase init`, `project
 * create` and `project remove` exit 0, and leave no extra worktree and no
 * project folder. Two repos with local bare origins, in a temp folder with
 * its own `HOME`; no network.
 *
 *   node --experimental-strip-types tests/e2e/round-trip.ts [--xr <file.js>]
 *
 * With `--xr`, it runs `<this runtime> <file.js>` instead of `xr` from PATH.
 * Type-only TypeScript with no imports outside `node:`, so Node 22.13 runs it.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Env = Record<string, string | undefined>;

interface Xr {
  command: string;
  prefix: string[];
  /** The npm shim on Windows is `xr.cmd`, which spawn runs only through a shell. */
  shell: boolean;
}

class StepFailed extends Error {}

/** The output of a step that exited 0; throws `StepFailed` otherwise. */
function step(
  label: string,
  command: string,
  args: string[],
  options: { cwd: string; env: Env; shell?: boolean },
): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    shell: options.shell ?? false,
  });
  if (result.status !== 0) {
    throw new StepFailed(
      [
        `step failed: ${label}`,
        `exit code ${result.status ?? `null (signal ${result.signal})`}`,
        ...(result.error ? [`error: ${result.error.message}`] : []),
        "stdout:",
        result.stdout ?? "",
        "stderr:",
        result.stderr ?? "",
      ].join("\n"),
    );
  }
  return result.stdout;
}

function git(cwd: string, env: Env, ...args: string[]): string {
  return step(`git ${args.join(" ")} (in ${cwd})`, "git", args, { cwd, env });
}

/**
 * How the repos and the project folder differ from the state after a create
 * (`created`: 2 worktrees per repo, the folder exists) or after a remove (only
 * the main checkout, no folder).
 */
function problems(
  repos: string[],
  project: string,
  created: boolean,
  env: Env,
): string[] {
  const want = created ? 2 : 1;
  const found: string[] = [];
  for (const repo of repos) {
    const count = git(repo, env, "worktree", "list", "--porcelain")
      .split(/\r?\n/)
      .filter((line) => line.startsWith("worktree ")).length;
    if (count !== want) found.push(`${repo}: ${count} worktrees, want ${want}`);
  }
  if (created && !existsSync(project)) {
    found.push(`project folder is missing: ${project}`);
  }
  if (!created && existsSync(project)) {
    found.push(`project folder still exists: ${project}`);
  }
  return found;
}

/** A repo at `<codebase>/<name>` with one commit on `main`, pushed to a bare origin. */
function makeRepo(codebase: string, origins: string, name: string, env: Env) {
  const origin = join(origins, `${name}.git`);
  const repo = join(codebase, name);
  mkdirSync(origin, { recursive: true });
  mkdirSync(repo, { recursive: true });
  // `init` then `symbolic-ref`: `init --initial-branch` needs git 2.28.
  git(origin, env, "init", "--quiet", "--bare");
  git(origin, env, "symbolic-ref", "HEAD", "refs/heads/main");
  git(repo, env, "init", "--quiet");
  git(repo, env, "symbolic-ref", "HEAD", "refs/heads/main");
  git(repo, env, "commit", "--quiet", "--allow-empty", "-m", "first");
  git(repo, env, "remote", "add", "origin", origin);
  git(repo, env, "push", "--quiet", "origin", "main");
  git(repo, env, "remote", "set-head", "origin", "main");
  return repo;
}

function xrFromArgs(argv: string[]): Xr {
  const at = argv.indexOf("--xr");
  if (at >= 0) {
    const file = argv[at + 1];
    if (!file) throw new StepFailed("--xr needs a file");
    return { command: process.execPath, prefix: [resolve(file)], shell: false };
  }
  return process.platform === "win32"
    ? { command: "xr.cmd", prefix: [], shell: true }
    : { command: "xr", prefix: [], shell: false };
}

function roundTrip(argv: string[]): void {
  const xr = xrFromArgs(argv);
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "xr-e2e-")));
  try {
    const home = join(root, "home");
    const xdg = join(root, "xdg-config");
    mkdirSync(home);
    mkdirSync(xdg);
    writeFileSync(
      join(home, ".gitconfig"),
      "[user]\n\tname = xr e2e\n\temail = xr-e2e@example.com\n",
    );
    // Not GIT_CONFIG_GLOBAL: it needs git 2.32, and the floor is 2.27.
    const env: Env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: xdg,
      GIT_CONFIG_NOSYSTEM: "1",
    };
    delete env.GIT_CONFIG_GLOBAL;
    const codebase = join(root, "shop");
    const origins = join(root, "origins");
    const repos = ["api", "web"].map((name) =>
      makeRepo(codebase, origins, name, env),
    );

    const runXr = (...args: string[]) => {
      const label = `xr ${args.join(" ")}`;
      const out = step(label, xr.command, [...xr.prefix, ...args], {
        cwd: codebase,
        env,
        shell: xr.shell,
      });
      console.log(`ok: ${label}`);
      return out;
    };
    runXr("codebase", "init", "--json");
    const created = runXr("project", "create", "feat/e2e", "--all", "--json");
    const project = (JSON.parse(created) as { project?: unknown }).project;
    if (typeof project !== "string") {
      throw new StepFailed(`project create gave no project path:\n${created}`);
    }
    const missing = problems(repos, project, true, env);
    if (missing.length) {
      throw new StepFailed(["after project create:", ...missing].join("\n"));
    }
    runXr("project", "remove", "feat/e2e", "--json");
    const left = problems(repos, project, false, env);
    if (left.length) {
      throw new StepFailed(["left behind:", ...left].join("\n"));
    }
    console.log("round trip ok");
  } finally {
    // Windows can hold a file for a moment; a failed cleanup must not change the result.
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    } catch (error) {
      console.error(`could not delete ${root}: ${error}`);
    }
  }
}

try {
  roundTrip(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof StepFailed ? error.message : error);
  process.exit(1);
}
