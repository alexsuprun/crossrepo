import { describe, expect, test } from "bun:test";
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  gitRefs,
  snapshot,
  useProjectRepoEnv,
} from "../../helpers/project-repo.ts";

const t = useProjectRepoEnv();
const { env } = t;
const DOCTOR = ["doctor"];
const PROJECT_DOCTOR = ["project", "doctor"];
const CODEBASE_DOCTOR = ["codebase", "doctor"];

/** `xr doctor` and the routed command in one folder: same exit code, same JSON plus `scope`. */
async function expectRouted(
  scope: "project" | "codebase",
  routed: string[],
  cwd: string,
  extra: string[] = [],
) {
  const expected = await t.json([...extra, ...routed], { cwd });
  const result = await t.json([...extra, ...DOCTOR], { cwd });
  expect(result.code).toBe(expected.code);
  expect(result.data).toEqual({ ...expected.data, scope });
  expect(Object.keys(result.data)).toEqual([
    "ok",
    "warnings",
    "scope",
    ...Object.keys(expected.data).slice(2),
  ]);
  return result;
}

describe("xr doctor in a project folder", () => {
  test("a healthy project: scope project, then the project doctor output, exit 0", async () => {
    const result = await expectRouted("project", PROJECT_DOCTOR, env.login);
    expect(result.code).toBe(0);
    expect(result.data.project).toBe(env.login);
    expect(
      result.stdout.startsWith(
        '{"ok":true,"warnings":[],"scope":"project","project":',
      ),
    ).toBe(true);
    const routed = await t.run(PROJECT_DOCTOR, { cwd: env.login });
    const text = await t.run(DOCTOR, { cwd: env.login });
    expect(text.code).toBe(0);
    expect(text.stderr).toBe("");
    expect(text.stdout).toBe(`project\n\n${routed.stdout}`);
  });

  test("a deleted worktree folder: checks-failed, scope, project and checks next to error", async () => {
    rmSync(join(env.login, "api"), { recursive: true, force: true });
    const result = await expectRouted("project", PROJECT_DOCTOR, env.login);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("checks-failed");
    expect(Object.keys(result.data)).toEqual([
      "ok",
      "warnings",
      "scope",
      "project",
      "checks",
      "error",
    ]);
    const routed = await t.run(PROJECT_DOCTOR, { cwd: env.login });
    const text = await t.run(DOCTOR, { cwd: env.login });
    expect(text.code).toBe(1);
    expect(text.stdout).toBe("");
    expect(text.stderr).toBe(`project\n\n${routed.stderr}`);
  });

  test("a record with invalid YAML: the same output as project doctor there", async () => {
    writeFileSync(join(env.login, ".crossrepo", "project.yaml"), "a: [\n");
    const result = await expectRouted("project", PROJECT_DOCTOR, env.login);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("checks-failed");
    expect(
      result.data.checks.find(
        (item: { id: string }) => item.id === "project-record",
      )?.status,
    ).toBe("error");
  });

  test("a record without branch: the same output as project doctor there, the codebase checks run", async () => {
    writeFileSync(
      join(env.login, ".crossrepo", "project.yaml"),
      t
        .record()
        .split("\n")
        .filter((line) => !line.startsWith("branch:"))
        .join("\n"),
    );
    const result = await expectRouted("project", PROJECT_DOCTOR, env.login);
    expect(result.code).toBe(1);
    const codebaseItems = result.data.checks.slice(0, 7);
    expect(codebaseItems.map((item: { id: string }) => item.id)).toEqual([
      "unknown-config-key",
      "reserved-var-name",
      "repo-not-in-config",
      "repo-folder-missing",
      "agents-heading-no-repo",
      "agents-repo-no-heading",
      "stale-worktree",
    ]);
    expect(
      codebaseItems.every(
        (item: { status: string }) => item.status !== "skipped",
      ),
    ).toBe(true);
  });

  test("a moved codebase: the same output as project doctor there", async () => {
    const moved = join(env.iso.root, "shop-moved");
    renameSync(env.codebase, moved);
    const login = join(moved, ".projects", "feat--login");
    const result = await expectRouted("project", PROJECT_DOCTOR, login);
    expect(result.code).toBe(1);
    expect(
      result.data.checks.find(
        (item: { id: string }) => item.id === "codebase-path",
      )?.status,
    ).toBe("error");
  });
});

describe("xr doctor in a codebase folder", () => {
  test("a healthy codebase: scope codebase, then the codebase doctor output, exit 0", async () => {
    const result = await expectRouted(
      "codebase",
      CODEBASE_DOCTOR,
      env.codebase,
    );
    expect(result.code).toBe(0);
    expect(result.data.project).toBeUndefined();
    const routed = await t.run(CODEBASE_DOCTOR);
    const text = await t.run(DOCTOR);
    expect(text.code).toBe(0);
    expect(text.stderr).toBe("");
    expect(text.stdout).toBe(`codebase\n\n${routed.stdout}`);
  });

  test("a codebase with a problem: checks-failed, scope and checks next to error", async () => {
    rmSync(join(env.codebase, "web"), { recursive: true, force: true });
    const result = await expectRouted(
      "codebase",
      CODEBASE_DOCTOR,
      env.codebase,
    );
    expect(result.code).toBe(1);
    expect(Object.keys(result.data)).toEqual([
      "ok",
      "warnings",
      "scope",
      "checks",
      "error",
    ]);
  });

  test("an unknown config key: one warn item, no live warning", async () => {
    writeFileSync(env.configFile, `${t.configText()}repo: 1\n`);
    const result = await expectRouted(
      "codebase",
      CODEBASE_DOCTOR,
      env.codebase,
    );
    expect(result.code).toBe(0);
    expect(result.data.warnings).toEqual([]);
    expect(result.data.checks[0]).toMatchObject({
      id: "unknown-config-key",
      status: "warn",
    });
    const text = await t.run(DOCTOR);
    expect(text.stderr).toBe("");
  });
});

describe("xr doctor with --codebase-path", () => {
  test("a path to a codebase routes to the codebase doctor", async () => {
    const result = await expectRouted(
      "codebase",
      CODEBASE_DOCTOR,
      env.iso.root,
      ["--codebase-path", env.codebase],
    );
    expect(result.code).toBe(0);
  });

  test("a path to a project routes to the project doctor", async () => {
    const result = await expectRouted("project", PROJECT_DOCTOR, env.iso.root, [
      "--codebase-path",
      env.login,
    ]);
    expect(result.code).toBe(0);
    expect(result.data.project).toBe(env.login);
  });
});

describe("xr doctor refusals", () => {
  test("a folder that is not a codebase or project: not-a-codebase with the doctor hint, nothing runs", async () => {
    const result = await t.json(DOCTOR, { cwd: env.iso.root });
    expect(result.code).toBe(1);
    expect(result.data.error).toEqual({
      code: "not-a-codebase",
      message: `${env.iso.root} is not a crossrepo codebase or project.`,
      hint: "Run it in a codebase folder or a project folder, or give `--codebase-path`.",
    });
    expect(result.data.scope).toBeUndefined();
    expect(result.data.checks).toBeUndefined();
  });

  test("other commands keep their own hint", async () => {
    const result = await t.json(CODEBASE_DOCTOR, { cwd: env.iso.root });
    expect(result.data.error.hint).toBe(
      "Run xr in a codebase folder, or use `--codebase-path <path>`.",
    );
  });

  test("an argument is a usage error, exit 2", async () => {
    const result = await t.run([...DOCTOR, "foo"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
  });
});

describe("xr doctor reads only", () => {
  test("no file, lock or git ref changes, also when checks fail", async () => {
    rmSync(join(env.login, "api"), { recursive: true, force: true });
    const files = snapshot(env.codebase);
    const before = {
      api: gitRefs(env.codebase, "api"),
      web: gitRefs(env.codebase, "web"),
    };
    // The missing worktree is an error in the project, only a stale-worktree warn in the codebase.
    expect((await t.run(DOCTOR, { cwd: env.login })).code).toBe(1);
    expect((await t.run(DOCTOR, { cwd: env.codebase })).code).toBe(0);
    expect(snapshot(env.codebase)).toEqual(files);
    expect({
      api: gitRefs(env.codebase, "api"),
      web: gitRefs(env.codebase, "web"),
    }).toEqual(before);
    expect(existsSync(env.lockFile)).toBe(false);
  });
});
