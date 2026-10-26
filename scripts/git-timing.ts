// Temporary diagnostic: the cost of one process start and one git start on this machine.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const windows = process.platform === "win32";
const runs = 200;
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function run(command: string, args: string[], cwd?: string) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")}: ${result.error ?? result.stderr}`,
    );
  }
}

function time(label: string, count: number, body: (i: number) => void) {
  const start = performance.now();
  for (let i = 0; i < count; i++) body(i);
  const each = (performance.now() - start) / count;
  console.log(`${label.padEnd(60)} ${each.toFixed(1).padStart(7)} ms`);
}

console.log(`platform ${process.platform}, bun ${Bun.version}`);
console.log(`git on PATH (Bun.which): ${Bun.which("git")}`);

const baseline = windows
  ? "C:\\Windows\\System32\\hostname.exe"
  : "/usr/bin/true";
time(`no-git process: ${baseline}`, runs, () => run(baseline, []));

const gits = windows
  ? [
      "git",
      "C:\\Program Files\\Git\\cmd\\git.exe",
      "C:\\Program Files\\Git\\bin\\git.exe",
      "C:\\Program Files\\Git\\mingw64\\bin\\git.exe",
    ]
  : ["git", "/usr/bin/git"];

const root = mkdtempSync(join(tmpdir(), "git-timing-"));
for (const git of gits) {
  if (git !== "git" && !existsSync(git)) {
    console.log(`${git}: not found`);
    continue;
  }
  time(`git --version via ${git}`, runs, () => run(git, ["--version"]));
  const base = mkdtempSync(join(root, "repos-"));
  time(`git init + commit via ${git} (per pair)`, runs / 2, (i) => {
    const dir = join(base, String(i));
    mkdirSync(dir);
    run(git, ["init", "--quiet"], dir);
    run(git, ["commit", "--quiet", "--allow-empty", "-m", "x"], dir);
  });
}
