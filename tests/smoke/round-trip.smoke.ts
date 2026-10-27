import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { smokeRuntimes } from "../helpers/smoke-runtimes.ts";

const script = fileURLToPath(new URL("../e2e/round-trip.ts", import.meta.url));
const bundle = fileURLToPath(new URL("../../dist/xr.js", import.meta.url));

// The round trip starts git and the bundle many times; slow CI runners need the room.
setDefaultTimeout(60_000);

const runtimes = smokeRuntimes(process.env.XR_SMOKE_RUNTIMES, process.execPath);

describe.each(runtimes)("tests/e2e/round-trip.ts under %s", (name, command) => {
  // The e2e CI job runs the script with Node 22.13, which needs the flag.
  const run = (...args: string[]) =>
    spawnSync(
      command,
      [
        ...(name === "node" ? ["--experimental-strip-types"] : []),
        script,
        ...args,
      ],
      { encoding: "utf8", env: { ...process.env } },
    );

  test("--xr dist/xr.js: init, create and remove exit 0 and leave nothing, exit 0", () => {
    const result = run("--xr", bundle);
    expect(result.error).toBeUndefined();
    expect({
      status: result.status,
      output: result.stdout + result.stderr,
    }).toMatchObject({ status: 0 });
    expect(result.stdout).toContain("round trip ok");
  });

  /** Runs the script with a fake xr made of `body`, which gets `args`, `join` and `cwd`. */
  const runFake = (body: string) => {
    const dir = mkdtempSync(join(tmpdir(), "xr-fake-"));
    try {
      const fake = join(dir, "fake-xr.js");
      writeFileSync(
        fake,
        [
          'const { execFileSync } = require("node:child_process");',
          'const { mkdirSync, rmSync } = require("node:fs");',
          'const { join } = require("node:path");',
          "const args = process.argv.slice(2);",
          "const cwd = process.cwd();",
          "const create = args[0] === 'project' && args[1] === 'create';",
          "const project = join(cwd, '.projects', 'feat--e2e');",
          body,
        ].join("\n"),
      );
      return run("--xr", fake);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("a step that exits non-zero: the step, its exit code and output, exit 1", () => {
    const result = runFake('console.log("boom out");\nprocess.exit(3);');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("codebase init --json");
    expect(result.stderr).toContain("exit code 3");
    expect(result.stderr).toContain("boom out");
    expect(result.stderr).not.toContain("project create");
  });

  // A fake create that makes the project folder and a worktree in each repo.
  const CREATE = [
    "const remove = args[0] === 'project' && args[1] === 'remove';",
    "const wt = (repo, ...rest) => execFileSync('git', ['-C', join(cwd, repo), 'worktree', ...rest]);",
    "if (create) {",
    "  for (const repo of ['api', 'web']) wt(repo, 'add', '--quiet', '-b', 'feat/e2e', join(project, repo));",
    "  console.log(JSON.stringify({ ok: true, project }));",
    "}",
  ].join("\n");

  test("a create that exits 0 but makes nothing: names the path and the repos, exit 1", () => {
    const result = runFake(
      "if (create) console.log(JSON.stringify({ ok: true, project }));",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("after project create:");
    expect(result.stderr).toMatch(
      /project folder is missing: .*[\\/]\.projects[\\/]feat--e2e/,
    );
    expect(result.stderr).toMatch(/[\\/]api: 1 worktrees, want 2/);
    expect(result.stderr).toMatch(/[\\/]web: 1 worktrees, want 2/);
    expect(result.stderr).not.toContain("ok: xr project remove");
  });

  test("a worktree left after remove: names the repo, exit 1", () => {
    const result = runFake(
      [
        CREATE,
        "if (remove) {",
        "  wt('api', 'remove', join(project, 'api'));",
        "  rmSync(join(project, 'web'), { recursive: true, force: true });",
        "}",
      ].join("\n"),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("left behind:");
    expect(result.stderr).toMatch(/[\\/]web: 2 worktrees, want 1/);
    expect(result.stderr).not.toContain("api:");
    expect(result.stdout).not.toContain("round trip ok");
  });

  test("a project folder left after remove: names the path, exit 1", () => {
    const result = runFake(
      [
        CREATE,
        "if (remove) for (const repo of ['api', 'web']) wt(repo, 'remove', join(project, repo));",
      ].join("\n"),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("left behind:");
    expect(result.stderr).toMatch(
      /project folder still exists: .*[\\/]\.projects[\\/]feat--e2e/,
    );
    expect(result.stderr).not.toContain("worktrees, want");
    expect(result.stdout).not.toContain("round trip ok");
  });
});
