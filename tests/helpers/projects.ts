import { spyOn } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as gitAdapter from "../../src/adapters/git/index.ts";
import { main } from "../../src/cli/index.ts";
import { renderProjectRecord } from "../../src/domain/project-record.ts";
import { writeFile } from "./isolate.ts";

/** A codebase with `api`, `web` and `docs` in its config. No git repo is needed. */
export function makeCodebase(codebase: string): void {
  writeFile(
    join(codebase, ".crossrepo", "config.yaml"),
    "repos:\n  api:\n    remote: a.git\n  web:\n    remote: w.git\n  docs:\n    remote: d.git\n",
  );
}

export interface RecordOptions {
  /** The codebase the record points to. */
  codebase: string;
  created?: string | null;
  /** Make a worktree folder for each repo. Default true. */
  folders?: boolean;
}

/** Writes `<projects>/<name>/.crossrepo/project.yaml`, and a folder per repo. Gives the project folder. */
export function makeProject(
  projects: string,
  name: string,
  branch: string,
  repos: string[],
  { codebase, created = "2026-10-20T14:03:12Z", folders = true }: RecordOptions,
): string {
  const dir = join(projects, name);
  const text = renderProjectRecord({
    branch,
    codebase,
    repos,
    created: created ?? "",
  });
  writeFile(
    join(dir, ".crossrepo", "project.yaml"),
    created === null ? text.replace(/^created:.*\n/m, "") : text,
  );
  if (folders) {
    for (const repo of repos) mkdirSync(join(dir, repo), { recursive: true });
  }
  return dir;
}

/** Makes every git adapter call fail, so a test proves the command makes none. Gives the spy. */
export function forbidGit(): { mockRestore(): void } {
  return spyOn(gitAdapter, "createGit").mockImplementation(
    () =>
      new Proxy({} as gitAdapter.Git, {
        get(_, name) {
          return () => {
            throw new Error(`git ${String(name)} must not run`);
          };
        },
      }),
  );
}

export interface RunInput {
  argv: string[];
  cwd: string;
  home: string;
  tty?: boolean;
}

/** Runs `xr` in-process and gives the exit code and both streams. */
export async function runXr({ argv, cwd, home, tty = false }: RunInput) {
  let stdout = "";
  let stderr = "";
  const env = { ...process.env };
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  const code = await main({
    version: "1.2.3",
    argv,
    env,
    isTTY: { stdin: tty, stdout: tty, stderr: false },
    cwd,
    home,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}
