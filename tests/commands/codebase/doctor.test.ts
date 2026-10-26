import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { main } from "../../../src/cli/index.ts";
import { git, makeRepos } from "../../helpers/git.ts";
import { type Isolation, isolate, writeFile } from "../../helpers/isolate.ts";
import { useProjectRepoEnv } from "../../helpers/project-repo.ts";

const DOCTOR = ["codebase", "doctor"];
const AGENTS = "# Team\n\n## Repos\n\n### api\n\nA.\n\n### web\n\nW.\n";
const CHECK_IDS = [
  "unknown-config-key",
  "reserved-var-name",
  "repo-not-in-config",
  "repo-folder-missing",
  "agents-heading-no-repo",
  "agents-repo-no-heading",
  "stale-worktree",
];

/** Every file under `dir` with its text, skipping the inside of `.git` folders. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    if (/(^|[\\/])\.git([\\/]|$)/.test(name)) continue;
    const path = join(dir, name);
    files[name] = statSync(path).isDirectory()
      ? "<dir>"
      : readFileSync(path, "utf8");
  }
  return files;
}

describe("xr codebase doctor in a codebase", () => {
  let iso: Isolation;
  let codebase: string;
  let configFile: string;
  let lockFile: string;
  let remotes: Record<string, string | undefined>;

  beforeEach(() => {
    iso = isolate();
    codebase = join(iso.root, "shop");
    configFile = join(codebase, ".crossrepo", "config.yaml");
    lockFile = join(codebase, ".crossrepo", "xr.lock");
    remotes = makeRepos(codebase, { api: {}, web: {} });
    writeConfig();
    writeFile(join(codebase, "AGENTS.md"), AGENTS);
  });

  afterEach(() => {
    iso.restore();
  });

  function writeConfig(extra = "", web = `\n    remote: ${remotes.web}`) {
    writeFile(
      configFile,
      `repos:\n  api:\n    remote: ${remotes.api}\n  web:${web}\n${extra}`,
    );
  }

  async function run(argv: string[], cwd = codebase) {
    let stdout = "";
    let stderr = "";
    const code = await main({
      version: "1.2.3",
      argv,
      env: {},
      isTTY: { stdin: false, stdout: false, stderr: false },
      cwd,
      home: iso.home,
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });
    return { code, stdout, stderr };
  }

  async function json(argv: string[], cwd = codebase) {
    const result = await run(["--json", ...argv], cwd);
    return { ...result, data: JSON.parse(result.stdout) };
  }

  function gitState(repo: string) {
    const dir = join(codebase, repo);
    return {
      refs: git(dir, "for-each-ref"),
      worktrees: git(dir, "worktree", "list", "--porcelain"),
    };
  }

  test("a clean codebase: 7 ok items, exit 0, in text and JSON", async () => {
    const text = await run(DOCTOR);
    expect(text.code).toBe(0);
    expect(text.stderr).toBe("");
    expect(text.stdout).toBe(CHECK_IDS.map((id) => `✓ ${id}\n`).join(""));
    const result = await json(DOCTOR);
    expect(result.code).toBe(0);
    expect(result.data).toEqual({
      ok: true,
      warnings: [],
      checks: CHECK_IDS.map((id) => ({ id, status: "ok" })),
    });
  });

  test("an unknown key: a warn item with the fix, no live warning, warnings is []", async () => {
    writeConfig("repo:\n  x: 1\n");
    const text = await run(DOCTOR);
    expect(text.code).toBe(0);
    expect(text.stderr).toBe("");
    expect(text.stdout).toContain(
      `! unknown-config-key  repo in ${configFile}\n    fix: rename it to \`repos\`\n`,
    );
    const result = await json(DOCTOR);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.data.warnings).toEqual([]);
    expect(result.data.checks[0]).toEqual({
      id: "unknown-config-key",
      status: "warn",
      message: `repo in ${configFile}`,
      fix: "rename it to `repos`",
    });
  });

  test("a reserved var: checks-failed, exit 1, checks next to error", async () => {
    writeConfig("project:\n  vars:\n    crossrepo_x: 1\n");
    const result = await json(DOCTOR);
    expect(result.code).toBe(1);
    expect(result.data.ok).toBe(false);
    expect(result.data.error).toEqual({
      code: "checks-failed",
      message: "1 check failed",
    });
    expect(result.data.checks).toContainEqual({
      id: "reserved-var-name",
      status: "error",
      message: "crossrepo_x",
      fix: `rename \`crossrepo_x\` in \`${configFile}\``,
    });
    expect(Object.keys(result.data)).toEqual([
      "ok",
      "warnings",
      "checks",
      "error",
    ]);
    const text = await run(DOCTOR);
    expect(text.code).toBe(1);
    expect(text.stdout).toBe("");
    expect(text.stderr).toContain("✗ reserved-var-name  crossrepo_x\n");
    expect(text.stderr).toEndWith("error: 1 check failed\n");
  });

  test("an extra git folder: a warn with the config lines, the remote line only with origin", async () => {
    const extra = makeRepos(codebase, { tools: {}, local: { origin: false } });
    const text = await run(DOCTOR);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain(
      [
        "! repo-not-in-config  local",
        "    fix: add to .crossrepo/config.yaml:",
        "        repos:",
        "          local:",
        "! repo-not-in-config  tools",
        "    fix: add to .crossrepo/config.yaml:",
        "        repos:",
        "          tools:",
        `            remote: ${extra.tools}`,
        "",
      ].join("\n"),
    );
    const result = await json(DOCTOR);
    expect(
      result.data.checks.filter(
        (item: { id: string }) => item.id === "repo-not-in-config",
      ),
    ).toEqual([
      {
        id: "repo-not-in-config",
        status: "warn",
        message: "local",
        fix: "add to .crossrepo/config.yaml:\n  repos:\n    local:",
      },
      {
        id: "repo-not-in-config",
        status: "warn",
        message: "tools",
        fix: `add to .crossrepo/config.yaml:\n  repos:\n    tools:\n      remote: ${extra.tools}`,
      },
    ]);
  });

  test("a missing repo: an error with git clone, exit 1", async () => {
    rmSync(join(codebase, "web"), { recursive: true, force: true });
    const result = await json(DOCTOR);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("checks-failed");
    expect(result.data.checks).toContainEqual({
      id: "repo-folder-missing",
      status: "error",
      message: "web",
      fix: `git clone ${remotes.web} web`,
    });
  });

  test("a missing repo with no remote (`web: null`): the plain clone fix", async () => {
    writeConfig("", " null");
    rmSync(join(codebase, "web"), { recursive: true, force: true });
    const result = await json(DOCTOR);
    expect(result.code).toBe(1);
    expect(result.data.checks).toContainEqual({
      id: "repo-folder-missing",
      status: "error",
      message: "web",
      fix: "clone the repo into `web`",
    });
  });

  test("a stray heading and a repo with no heading: warns, exit 0", async () => {
    writeFile(join(codebase, "AGENTS.md"), "## Repos\n\n### API\n\n### old\n");
    const text = await run(DOCTOR);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain(
      [
        "! agents-heading-no-repo  old",
        "    fix: rename it to a repo name, or remove it",
        "! agents-repo-no-heading  web",
        '    fix: add "### web" under "## Repos" in AGENTS.md',
        "",
      ].join("\n"),
    );
  });

  test("no AGENTS.md: one section item, agents-heading-no-repo ok, exit 0", async () => {
    rmSync(join(codebase, "AGENTS.md"));
    const result = await json(DOCTOR);
    expect(result.code).toBe(0);
    expect(result.data.checks.slice(4, 6)).toEqual([
      { id: "agents-heading-no-repo", status: "ok" },
      {
        id: "agents-repo-no-heading",
        status: "warn",
        fix: "add a `## Repos` section with one `### <repo>` per repo",
      },
    ]);
  });

  test("a stale worktree: a warn with the path and the prune fix, exit 0, git not changed", async () => {
    const api = join(codebase, "api");
    const gone = join(iso.root, "gone");
    git(api, "worktree", "add", "--quiet", "-b", "x", gone);
    rmSync(gone, { recursive: true, force: true });
    const before = gitState("api");
    const result = await json(DOCTOR);
    expect(result.code).toBe(0);
    expect(result.data.checks.at(-1)).toEqual({
      id: "stale-worktree",
      status: "warn",
      message: gone,
      fix: `git -C "${api}" worktree prune`,
    });
    expect(gitState("api")).toEqual(before);
    const text = await run(DOCTOR);
    expect(text.stdout).toContain(
      `! stale-worktree  ${gone}\n    fix: git -C "${api}" worktree prune\n`,
    );
  });

  test("many problems: no file, lock or git ref changes", async () => {
    writeConfig("repo: 1\nproject:\n  vars:\n    CROSSREPO_X: 1\n");
    rmSync(join(codebase, "web"), { recursive: true, force: true });
    makeRepos(codebase, { tools: {} });
    mkdirSync(join(codebase, ".projects"));
    const files = snapshot(codebase);
    const before = gitState("api");
    const result = await run(DOCTOR);
    expect(result.code).toBe(1);
    expect(snapshot(codebase)).toEqual(files);
    expect(gitState("api")).toEqual(before);
    expect(existsSync(lockFile)).toBe(false);
  });

  test("a folder that is not a codebase: not-a-codebase, nothing runs", async () => {
    const other = join(iso.root, "other");
    mkdirSync(other);
    const result = await json(DOCTOR, other);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("not-a-codebase");
    expect(result.data.checks).toBeUndefined();
  });

  test("a config that cannot load: invalid-config, as today", async () => {
    writeFile(configFile, "repos: [\n");
    const result = await json(DOCTOR);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("invalid-config");
    expect(result.data.checks).toBeUndefined();
  });

  test("an argument is a usage error", async () => {
    const result = await run([...DOCTOR, "extra"]);
    expect(result.code).toBe(2);
  });

  test("other commands still print the live unknown-key warning", async () => {
    writeConfig("repo: 1\n");
    const result = await json(["codebase", "repo", "list"]);
    expect(result.data.warnings).toHaveLength(1);
    expect(result.data.warnings[0].code).toBe("unknown-config-key");
  });
});

describe("xr codebase doctor in a project folder", () => {
  const { env, json } = useProjectRepoEnv();

  test("checks the codebase of the record", async () => {
    rmSync(join(env.codebase, "docs"), { recursive: true, force: true });
    const result = await json(DOCTOR, { cwd: env.login });
    expect(result.code).toBe(1);
    expect(result.data.checks).toContainEqual({
      id: "repo-folder-missing",
      status: "error",
      message: "docs",
      fix: `git clone ${env.remotes.docs} docs`,
    });
    expect(existsSync(env.lockFile)).toBe(false);
  });
});
