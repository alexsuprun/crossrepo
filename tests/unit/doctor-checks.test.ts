import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createFs } from "../../src/adapters/fs/index.ts";
import { createGit } from "../../src/adapters/git/index.ts";
import { configView } from "../../src/cli/index.ts";
import { loadConfig } from "../../src/config/index.ts";
import type { ConfigView, Ctx } from "../../src/domain/ctx.ts";
import type { Block, CheckItem } from "../../src/domain/report.ts";
import { XrError } from "../../src/errors/index.ts";
import {
  CODEBASE_CHECK_IDS,
  codebaseChecks,
  finishChecks,
  isReservedVarName,
  PROJECT_CHECK_IDS,
  projectDoctorChecks,
  rejectReservedVars,
  reservedVars,
} from "../../src/services/doctor-checks.ts";
import { git, makeRepos } from "../helpers/git.ts";
import { type Isolation, isolate, writeFile } from "../helpers/isolate.ts";

let iso: Isolation;
let codebase: string;
let configFile: string;
let remotes: Record<string, string | undefined>;

const AGENTS = "# Team\n\n## Repos\n\n### api\n\nA.\n\n### web\n\nW.\n";

beforeEach(() => {
  iso = isolate();
  codebase = join(iso.root, "shop");
  configFile = join(codebase, ".crossrepo", "config.yaml");
  remotes = makeRepos(codebase, { api: {}, web: {} });
  writeConfig();
  writeFile(join(codebase, "AGENTS.md"), AGENTS);
});

afterEach(() => {
  iso.restore();
});

function writeConfig(extra = "") {
  writeFile(
    configFile,
    [
      "repos:",
      "  api:",
      `    remote: ${remotes.api}`,
      "  web:",
      `    remote: ${remotes.web}`,
      extra,
      "",
    ].join("\n"),
  );
}

function config(): ConfigView {
  return configView(loadConfig({ home: iso.home, codebase }));
}

/** `gitVersion` stands in for `git version`, so the fix texts do not depend on the git of the machine. */
function ctx(
  view: ConfigView = config(),
  gitVersion = "2.45.1",
): Pick<Ctx, "fs" | "git" | "config"> {
  return {
    fs: createFs(),
    git: {
      ...createGit({ interactive: false, env: { ...process.env } }),
      version: async () => gitVersion,
    },
    config: view,
  };
}

async function itemsOf(id: string, view?: ConfigView): Promise<CheckItem[]> {
  const items = await codebaseChecks(ctx(view), codebase);
  return items.filter((item) => item.id === id);
}

describe("codebaseChecks", () => {
  test("a clean codebase gives one ok item per check, in order", async () => {
    const items = await codebaseChecks(ctx(), codebase);
    expect(items).toEqual(
      [
        "unknown-config-key",
        "reserved-var-name",
        "repo-not-in-config",
        "repo-folder-missing",
        "agents-heading-no-repo",
        "agents-repo-no-heading",
        "stale-worktree",
      ].map((id) => ({ id, status: "ok" })),
    );
    expect<string[]>([...CODEBASE_CHECK_IDS]).toEqual(
      items.map((item) => item.id),
    );
  });

  test("unknown-config-key: one warn per key, with its files and the suggestion", async () => {
    writeFile(join(iso.home, ".crossrepo", "config.yaml"), "repo: x\n");
    writeConfig("repo: y\nprojets-dir: z");
    expect(await itemsOf("unknown-config-key")).toEqual([
      {
        id: "unknown-config-key",
        status: "warn",
        message: `repo in ${join(iso.home, ".crossrepo", "config.yaml")}, ${configFile}`,
        fix: "rename it to `repos`",
      },
      {
        id: "unknown-config-key",
        status: "warn",
        message: `projets-dir in ${configFile}`,
        fix: "rename it to `projects-dir`",
      },
    ]);
  });

  test("unknown-config-key: no suggestion gives the fix 'remove it'", async () => {
    const view = {
      ...config(),
      unknownKeys: [{ key: "zzz", files: [configFile], suggestion: "" }],
    };
    expect(await itemsOf("unknown-config-key", view)).toEqual([
      {
        id: "unknown-config-key",
        status: "warn",
        message: `zzz in ${configFile}`,
        fix: "remove it",
      },
    ]);
  });

  test("reserved-var-name: one error per CROSSREPO_ name in any case, naming the winning file", async () => {
    const local = join(codebase, ".crossrepo", "config.local.yaml");
    writeConfig("project:\n  vars:\n    crossrepo_x: 1\n    PORT: 2");
    writeFile(local, "project:\n  vars:\n    CrossRepo_Y: 3\n");
    expect(await itemsOf("reserved-var-name")).toEqual([
      {
        id: "reserved-var-name",
        status: "error",
        message: "crossrepo_x",
        fix: `rename \`crossrepo_x\` in \`${configFile}\``,
      },
      {
        id: "reserved-var-name",
        status: "error",
        message: "CrossRepo_Y",
        fix: `rename \`CrossRepo_Y\` in \`${local}\``,
      },
    ]);
  });

  test("repo-not-in-config: a git folder not in repos, with the remote line only when it has origin", async () => {
    const extra = makeRepos(codebase, {
      tools: {},
      bare: { origin: false },
    });
    mkdirSync(join(codebase, "plain"));
    expect(await itemsOf("repo-not-in-config")).toEqual([
      {
        id: "repo-not-in-config",
        status: "warn",
        message: "bare",
        fix: "add to .crossrepo/config.yaml:\n  repos:\n    bare:",
      },
      {
        id: "repo-not-in-config",
        status: "warn",
        message: "tools",
        fix: `add to .crossrepo/config.yaml:\n  repos:\n    tools:\n      remote: ${extra.tools}`,
      },
    ]);
  });

  test("repo-not-in-config: the fix names config.yml when that is the codebase file", async () => {
    rmSync(configFile);
    writeFile(
      join(codebase, ".crossrepo", "config.yml"),
      `repos:\n  api:\n    remote: ${remotes.api}\n`,
    );
    const [item] = await itemsOf("repo-not-in-config");
    expect(item?.message).toBe("web");
    expect(item?.fix).toStartWith("add to .crossrepo/config.yml:\n");
  });

  test("repo-folder-missing: an error with git clone, or the plain fix with no remote", async () => {
    writeConfig("  docs:\n    remote: d.git\n  site:");
    expect(await itemsOf("repo-folder-missing")).toEqual([
      {
        id: "repo-folder-missing",
        status: "error",
        message: "docs",
        fix: { code: "git clone d.git docs" },
      },
      {
        id: "repo-folder-missing",
        status: "error",
        message: "site",
        fix: "clone the repo into `site`",
      },
    ]);
  });

  test("a null repos key counts as a repo for the folder and heading checks", async () => {
    makeRepos(codebase, { tools: { origin: false } });
    writeConfig("  tools:");
    expect(await itemsOf("repo-not-in-config")).toEqual([
      { id: "repo-not-in-config", status: "ok" },
    ]);
    expect(await itemsOf("agents-repo-no-heading")).toEqual([
      {
        id: "agents-repo-no-heading",
        status: "warn",
        message: "tools",
        fix: 'add "### tools" under "## Repos" in AGENTS.md',
      },
    ]);
  });

  test("repo-folder-missing: a configured folder with no .git is not reported", async () => {
    writeConfig("  docs:\n    remote: d.git");
    mkdirSync(join(codebase, "docs"));
    expect(await itemsOf("repo-folder-missing")).toEqual([
      { id: "repo-folder-missing", status: "ok" },
    ]);
  });

  test("agents headings: a stray heading and a repo with no heading, matched in any case", async () => {
    writeFile(
      join(codebase, "AGENTS.md"),
      "## Repos\n\n### API\n\n```\n### web\n```\n\n### old\n",
    );
    expect(await itemsOf("agents-heading-no-repo")).toEqual([
      {
        id: "agents-heading-no-repo",
        status: "warn",
        message: "old",
        fix: "rename it to a repo name, or remove it",
      },
    ]);
    expect(await itemsOf("agents-repo-no-heading")).toEqual([
      {
        id: "agents-repo-no-heading",
        status: "warn",
        message: "web",
        fix: 'add "### web" under "## Repos" in AGENTS.md',
      },
    ]);
  });

  for (const [name, text] of [
    ["no AGENTS.md", undefined],
    ["no ## Repos", "# Team\n\n### api\n"],
  ] as const) {
    test(`${name}: one section item, and agents-heading-no-repo is ok`, async () => {
      const file = join(codebase, "AGENTS.md");
      if (text === undefined) rmSync(file);
      else writeFile(file, text);
      expect(await itemsOf("agents-heading-no-repo")).toEqual([
        { id: "agents-heading-no-repo", status: "ok" },
      ]);
      expect(await itemsOf("agents-repo-no-heading")).toEqual([
        {
          id: "agents-repo-no-heading",
          status: "warn",
          fix: "add a `## Repos` section with one `### <repo>` per repo",
        },
      ]);
    });
  }

  test("agents-repo-no-heading is ok with no repos, also with no AGENTS.md", async () => {
    writeFile(configFile, "name: shop\n");
    rmSync(join(codebase, "AGENTS.md"));
    expect(await itemsOf("agents-repo-no-heading")).toEqual([
      { id: "agents-repo-no-heading", status: "ok" },
    ]);
  });

  test("stale-worktree: an entry whose folder is gone, with the prune fix", async () => {
    const api = join(codebase, "api");
    const gone = join(iso.root, "wt-gone");
    const kept = join(iso.root, "wt-kept");
    git(api, "worktree", "add", "--quiet", "-b", "a", gone);
    git(api, "worktree", "add", "--quiet", "-b", "b", kept);
    rmSync(gone, { recursive: true, force: true });
    expect(await itemsOf("stale-worktree")).toEqual([
      {
        id: "stale-worktree",
        status: "warn",
        message: { path: gone },
        fix: { code: `git -C "${api}" worktree prune` },
      },
    ]);
    // Read-only: the entry is still there. git prints `/` in paths on Windows too.
    expect(git(api, "worktree", "list", "--porcelain")).toContain(
      gone.replaceAll("\\", "/"),
    );
  });

  test("stale-worktree skips a repo folder with no .git", async () => {
    writeConfig("  docs:\n    remote: d.git");
    mkdirSync(join(codebase, "docs"));
    expect(await itemsOf("stale-worktree")).toEqual([
      { id: "stale-worktree", status: "ok" },
    ]);
  });
});

describe("codebaseChecks with a .git that git cannot read", () => {
  test("still gives all seven checks: no remote line in check 3, the repo skipped in check 7", async () => {
    writeFile(join(codebase, "broken", ".git"), "gitdir: /nope/x\n");
    rmSync(join(codebase, "web"), { recursive: true, force: true });
    writeFile(join(codebase, "web", ".git"), "gitdir: /nope/y\n");
    const items = await codebaseChecks(ctx(), codebase);
    expect(new Set(items.map((item) => item.id))).toEqual(
      new Set(CODEBASE_CHECK_IDS),
    );
    expect(items.filter((item) => item.id === "repo-not-in-config")).toEqual([
      {
        id: "repo-not-in-config",
        status: "warn",
        message: "broken",
        fix: "add to .crossrepo/config.yaml:\n  repos:\n    broken:",
      },
    ]);
    expect(items.filter((item) => item.id === "stale-worktree")).toEqual([
      { id: "stale-worktree", status: "ok" },
    ]);
  });
});

describe("reserved var names", () => {
  test("isReservedVarName matches the CROSSREPO_ prefix in any case only", () => {
    expect(isReservedVarName("CROSSREPO_X")).toBe(true);
    expect(isReservedVarName("crossrepo_x")).toBe(true);
    expect(isReservedVarName("CrossRepo_")).toBe(true);
    expect(isReservedVarName("CROSSREPO")).toBe(false);
    expect(isReservedVarName("MY_CROSSREPO_X")).toBe(false);
  });

  test("reservedVars gives each bad name with its winning file", () => {
    writeConfig("project:\n  vars:\n    CROSSREPO_X: 1\n    PORT: 2");
    expect(reservedVars(config())).toEqual([
      { name: "CROSSREPO_X", file: configFile },
    ]);
  });

  test("rejectReservedVars throws reserved-var-name with each name and file", () => {
    writeConfig("project:\n  vars:\n    CROSSREPO_X: 1\n    crossrepo_y: 2");
    let thrown: unknown;
    try {
      rejectReservedVars(config());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(XrError);
    const error = thrown as XrError;
    expect(error.code).toBe("reserved-var-name");
    expect(error.message).toBe(
      `Reserved var names in \`project.vars\`: \`CROSSREPO_X\` (${configFile}), \`crossrepo_y\` (${configFile}).`,
    );
    expect(error.hint).toBe("xr codebase doctor");
  });

  test("rejectReservedVars does nothing with no bad name", () => {
    writeConfig("project:\n  vars:\n    PORT: 2");
    expect(() => rejectReservedVars(config())).not.toThrow();
  });
});

describe("finishChecks", () => {
  const ok: CheckItem = { id: "a", status: "ok" };
  const warn: CheckItem = { id: "b", status: "warn", message: "m" };
  const bad: CheckItem = { id: "c", status: "error", message: "x" };

  test("with no error, gives the Report with one checks block", () => {
    expect(finishChecks([ok, warn])).toEqual({
      blocks: [{ type: "checks", items: [ok, warn] }],
    });
  });

  test("leading blocks go before the checks block, also next to error", () => {
    const head: Block = {
      type: "value",
      key: "project",
      value: { path: "/p" },
    };
    expect(finishChecks([ok], [head])).toEqual({
      blocks: [head, { type: "checks", items: [ok] }],
    });
    let thrown: unknown;
    try {
      finishChecks([bad], [head]);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as XrError).report).toEqual([
      head,
      { type: "checks", items: [bad] },
    ]);
  });

  test("with errors, throws checks-failed with the count and the checks next to error", () => {
    for (const [items, message] of [
      [[ok, bad], "1 check failed"],
      [[bad, warn, bad], "2 checks failed"],
    ] as const) {
      let thrown: unknown;
      try {
        finishChecks([...items]);
      } catch (error) {
        thrown = error;
      }
      const error = thrown as XrError;
      expect(error).toBeInstanceOf(XrError);
      expect(error.code).toBe("checks-failed");
      expect(error.message).toBe(message);
      expect(error.hint).toBeUndefined();
      expect(error.report).toEqual([{ type: "checks", items: [...items] }]);
    }
  });
});

describe("projectDoctorChecks", () => {
  const BRANCH = "feat/x";
  const PROJECT_AGENTS =
    "# P\n\n## Codebase\n\nC.\n\n## Repos\n\n### api\n\nA.\n";
  let project: string;
  let recordFile: string;

  beforeEach(() => {
    project = join(iso.root, "work", "feat");
    recordFile = join(project, ".crossrepo", "project.yaml");
    git(
      join(codebase, "api"),
      "worktree",
      "add",
      "--quiet",
      "-b",
      BRANCH,
      wt("api"),
    );
    writeRecord();
    writeFile(join(project, "AGENTS.md"), PROJECT_AGENTS);
  });

  function wt(repo: string): string {
    return join(project, repo);
  }

  function writeRecord(
    lines = [
      `branch: ${BRANCH}`,
      `codebase: ${JSON.stringify(codebase)}`,
      "repos:",
      "  - api",
    ],
  ) {
    writeFile(recordFile, `${lines.join("\n")}\n`);
  }

  async function projectItems(
    id?: string,
    gitVersion?: string,
  ): Promise<CheckItem[]> {
    const items = await projectDoctorChecks(
      ctx(config(), gitVersion),
      project,
      codebase,
    );
    return id === undefined ? items : items.filter((item) => item.id === id);
  }

  const skipped = (id: string, message: string): CheckItem => ({
    id,
    status: "skipped",
    message,
  });

  test("a healthy project: the 7 codebase checks then the 7 project checks, all ok", async () => {
    const items = await projectItems();
    expect(items).toEqual(
      [...CODEBASE_CHECK_IDS, ...PROJECT_CHECK_IDS].map((id) => ({
        id,
        status: "ok",
      })),
    );
    expect<string[]>([...PROJECT_CHECK_IDS]).toEqual([
      "project-record",
      "codebase-path",
      "worktree-missing",
      "worktree-not-registered",
      "worktree-branch",
      "project-drift",
      "project-agents-md",
    ]);
  });

  test("project-record: no branch is an error, checks 2 to 7 skipped, codebase checks still run", async () => {
    writeRecord([`codebase: ${JSON.stringify(codebase)}`, "repos:", "  - api"]);
    const items = await projectItems();
    expect(items.slice(0, 7)).toEqual(
      CODEBASE_CHECK_IDS.map((id) => ({ id, status: "ok" })),
    );
    expect(items.slice(7)).toEqual([
      {
        id: "project-record",
        status: "error",
        message: `${recordFile}: it has no \`branch\``,
        fix: "correct `.crossrepo/project.yaml`: keys branch, codebase, repos, created",
      },
      ...PROJECT_CHECK_IDS.slice(1).map((id) =>
        skipped(id, "project record cannot be read"),
      ),
    ]);
  });

  test("project-record: with no codebase found, the codebase checks are skipped too", async () => {
    writeFile(recordFile, "a: [\n");
    const items = await projectDoctorChecks(ctx(), project, undefined);
    expect(items.slice(0, 7)).toEqual(
      CODEBASE_CHECK_IDS.map((id) =>
        skipped(id, "project record cannot be read"),
      ),
    );
    expect(items[7]).toMatchObject({
      id: "project-record",
      status: "error",
    });
    expect(String(items[7]?.message)).toStartWith(
      `${recordFile}: it is not valid YAML`,
    );
  });

  test("project-record: a missing record cannot be read", async () => {
    rmSync(recordFile);
    expect(await projectItems("project-record")).toEqual([
      {
        id: "project-record",
        status: "error",
        message: `${recordFile}: it cannot be read`,
        fix: "correct `.crossrepo/project.yaml`: keys branch, codebase, repos, created",
      },
    ]);
  });

  test("codebase-path: a gone codebase is an error with the repair lines; codebase checks and 4, 5, 7 skipped; 3 and 6 run", async () => {
    const gone = join(iso.root, "gone");
    writeRecord([
      `branch: ${BRANCH}`,
      "codebase: ../../gone",
      "repos:",
      "  - api",
      "  - web",
    ]);
    const items = await projectDoctorChecks(ctx(), project, undefined);
    const notFound = "codebase not found";
    expect(items).toEqual([
      ...CODEBASE_CHECK_IDS.map((id) => skipped(id, notFound)),
      { id: "project-record", status: "ok" },
      {
        id: "codebase-path",
        status: "error",
        message: { path: gone },
        fix: [
          "set `codebase` in `.crossrepo/project.yaml` to the codebase folder, then run:",
          `git -C "<codebase>/api" worktree repair "${wt("api")}"`,
          `git -C "<codebase>/web" worktree repair "${wt("web")}"`,
        ].join("\n"),
      },
      {
        id: "worktree-missing",
        status: "error",
        message: "web",
        fix: "xr project repo remove web --project feat\nxr project repo add web --project feat",
      },
      skipped("worktree-not-registered", notFound),
      skipped("worktree-branch", notFound),
      { id: "project-drift", status: "ok" },
      skipped("project-agents-md", notFound),
    ]);
  });

  // `git worktree repair` needs git 2.29; the floor is 2.27.
  test("codebase-path: on git older than 2.29 the fix starts with the needs line", async () => {
    writeRecord([
      `branch: ${BRANCH}`,
      "codebase: ../../gone",
      "repos:",
      "  - api",
    ]);
    const items = await projectDoctorChecks(
      ctx(config(), "2.28.0"),
      project,
      undefined,
    );
    expect(items.find((item) => item.id === "codebase-path")?.fix).toBe(
      [
        "needs git 2.29 or newer (you have 2.28.0):",
        "set `codebase` in `.crossrepo/project.yaml` to the codebase folder, then run:",
        `git -C "<codebase>/api" worktree repair "${wt("api")}"`,
      ].join("\n"),
    );
  });

  test("codebase-path: on git 2.29 the fix has no needs line", async () => {
    writeRecord([
      `branch: ${BRANCH}`,
      "codebase: ../../gone",
      "repos:",
      "  - api",
    ]);
    const items = await projectDoctorChecks(
      ctx(config(), "2.29.0"),
      project,
      undefined,
    );
    expect(items.find((item) => item.id === "codebase-path")?.fix).toBe(
      [
        "set `codebase` in `.crossrepo/project.yaml` to the codebase folder, then run:",
        `git -C "<codebase>/api" worktree repair "${wt("api")}"`,
      ].join("\n"),
    );
  });

  test("codebase-path: when git cannot say its version, the fix has no needs line", async () => {
    writeRecord([
      `branch: ${BRANCH}`,
      "codebase: ../../gone",
      "repos:",
      "  - api",
    ]);
    const base = ctx();
    const failing = {
      ...base,
      git: {
        ...base.git,
        version: () => Promise.reject(new Error("no git")),
      },
    };
    const items = await projectDoctorChecks(failing, project, undefined);
    expect(
      String(items.find((item) => item.id === "codebase-path")?.fix),
    ).toStartWith("set `codebase`");
  });

  test("codebase-path: a folder that is not a codebase is an error", async () => {
    const plain = join(iso.root, "plain");
    mkdirSync(plain);
    writeRecord([
      `branch: ${BRANCH}`,
      `codebase: ${JSON.stringify(plain)}`,
      "repos: []",
    ]);
    expect(
      (await projectDoctorChecks(ctx(), project, undefined)).find(
        (item) => item.id === "codebase-path",
      ),
    ).toMatchObject({ status: "error", message: { path: plain } });
  });

  test("worktree-missing: one error per record repo with no folder", async () => {
    rmSync(wt("api"), { recursive: true, force: true });
    expect(await projectItems("worktree-missing")).toEqual([
      {
        id: "worktree-missing",
        status: "error",
        message: "api",
        fix: "xr project repo remove api --project feat\nxr project repo add api --project feat",
      },
    ]);
    expect(await projectItems("worktree-not-registered")).toEqual([
      { id: "worktree-not-registered", status: "ok" },
    ]);
  });

  test("worktree-not-registered: a moved project folder is an error with the repair fix", async () => {
    const moved = join(iso.root, "work", "moved");
    renameSync(project, moved);
    project = moved;
    expect(await projectItems("worktree-not-registered")).toEqual([
      {
        id: "worktree-not-registered",
        status: "error",
        message: { path: wt("api") },
        fix: {
          code: `git -C "${join(codebase, "api")}" worktree repair "${wt("api")}"`,
        },
      },
    ]);
    expect(await projectItems("worktree-branch")).toEqual([
      { id: "worktree-branch", status: "ok" },
    ]);
  });

  test("worktree-not-registered: on git older than 2.29 the fix starts with the needs line", async () => {
    const moved = join(iso.root, "work", "moved");
    renameSync(project, moved);
    project = moved;
    expect(
      await projectItems("worktree-not-registered", "2.27.0.windows.1"),
    ).toEqual([
      {
        id: "worktree-not-registered",
        status: "error",
        message: { path: wt("api") },
        fix: [
          "needs git 2.29 or newer (you have 2.27.0.windows.1):",
          `git -C "${join(codebase, "api")}" worktree repair "${wt("api")}"`,
        ].join("\n"),
      },
    ]);
  });

  test("worktree-not-registered: on git 2.29 the fix is the repair code", async () => {
    const moved = join(iso.root, "work", "moved");
    renameSync(project, moved);
    project = moved;
    expect(
      (await projectItems("worktree-not-registered", "2.29.0"))[0]?.fix,
    ).toEqual({
      code: `git -C "${join(codebase, "api")}" worktree repair "${wt("api")}"`,
    });
  });

  test("worktree-not-registered: a worktree git cannot read is one error, and no worktree-branch item", async () => {
    writeFile(join(wt("api"), ".git"), "gitdir: /nowhere/at/all\n");
    expect(await projectItems("worktree-not-registered")).toEqual([
      {
        id: "worktree-not-registered",
        status: "error",
        message: { path: wt("api") },
        fix: {
          code: `git -C "${join(codebase, "api")}" worktree repair "${wt("api")}"`,
        },
      },
    ]);
    expect(await projectItems("worktree-branch")).toEqual([
      { id: "worktree-branch", status: "ok" },
    ]);
  });

  test("worktree-not-registered: a repo whose codebase folder is missing gives no item", async () => {
    writeRecord([
      `branch: ${BRANCH}`,
      `codebase: ${JSON.stringify(codebase)}`,
      "repos:",
      "  - api",
      "  - docs",
    ]);
    mkdirSync(wt("docs"));
    expect(await projectItems("worktree-not-registered")).toEqual([
      { id: "worktree-not-registered", status: "ok" },
    ]);
  });

  test("worktree-not-registered: a codebase repo whose .git cannot be read gives no item", async () => {
    rmSync(join(codebase, "api", ".git"), { recursive: true, force: true });
    writeFile(join(codebase, "api", ".git"), "gitdir: /nope/x\n");
    expect(await projectItems("worktree-not-registered")).toEqual([
      { id: "worktree-not-registered", status: "ok" },
    ]);
  });

  test("worktree-branch: another branch is a warn with the switch fix", async () => {
    git(wt("api"), "switch", "--quiet", "-c", "other");
    expect(await projectItems("worktree-branch")).toEqual([
      {
        id: "worktree-branch",
        status: "warn",
        message: `${wt("api")}: on branch \`other\`, not \`${BRANCH}\`; \`xr project sync\` refuses this worktree`,
        fix: { code: `git -C "${wt("api")}" switch ${BRANCH}` },
      },
    ]);
  });

  test("worktree-branch: a detached HEAD is a warn", async () => {
    git(wt("api"), "switch", "--quiet", "--detach");
    expect(await projectItems("worktree-branch")).toEqual([
      {
        id: "worktree-branch",
        status: "warn",
        message: `${wt("api")}: detached HEAD; \`xr project sync\` refuses this worktree`,
        fix: { code: `git -C "${wt("api")}" switch ${BRANCH}` },
      },
    ]);
  });

  test("project-drift: one error per extra folder; dot folders and files do not count", async () => {
    mkdirSync(join(project, "tmp"));
    mkdirSync(join(project, ".idea"));
    writeFile(join(project, "notes.txt"), "x");
    expect(await projectItems("project-drift")).toEqual([
      {
        id: "project-drift",
        status: "error",
        message: "tmp",
        fix: "move `tmp` out of the project folder",
      },
    ]);
  });

  test("project-agents-md: no AGENTS.md is one warn with no message", async () => {
    rmSync(join(project, "AGENTS.md"));
    expect(await projectItems("project-agents-md")).toEqual([
      {
        id: "project-agents-md",
        status: "warn",
        fix: "add `AGENTS.md` with a `## Codebase` and a `## Repos` section",
      },
    ]);
  });

  test("project-agents-md: no ## Codebase, a stray heading and a missing repo heading", async () => {
    writeRecord([
      `branch: ${BRANCH}`,
      `codebase: ${JSON.stringify(codebase)}`,
      "repos:",
      "  - api",
      "  - web",
    ]);
    git(
      join(codebase, "web"),
      "worktree",
      "add",
      "--quiet",
      "-b",
      BRANCH,
      wt("web"),
    );
    writeFile(
      join(project, "AGENTS.md"),
      "# P\n\n## Repos\n\n### API \n\n```\n### web\n```\n\n### old\n",
    );
    expect(await projectItems("project-agents-md")).toEqual([
      {
        id: "project-agents-md",
        status: "warn",
        message: "## Codebase",
        fix: "add a `## Codebase` section to `AGENTS.md`",
      },
      {
        id: "project-agents-md",
        status: "warn",
        message: "old",
        fix: 'remove "### old" from "## Repos" in AGENTS.md',
      },
      {
        id: "project-agents-md",
        status: "warn",
        message: "web",
        fix: 'add "### web" under "## Repos" in AGENTS.md (copy it from the codebase AGENTS.md)',
      },
    ]);
  });

  test("project-agents-md: a repo with no codebase heading needs no project heading; no ## Repos counts as no titles", async () => {
    writeFile(join(codebase, "AGENTS.md"), "# Team\n\n## Repos\n\n### web\n");
    writeFile(join(project, "AGENTS.md"), "## Codebase\n\nC.\n");
    expect(await projectItems("project-agents-md")).toEqual([
      { id: "project-agents-md", status: "ok" },
    ]);
    writeFile(join(codebase, "AGENTS.md"), AGENTS);
    expect(await projectItems("project-agents-md")).toEqual([
      {
        id: "project-agents-md",
        status: "warn",
        message: "api",
        fix: 'add "### api" under "## Repos" in AGENTS.md (copy it from the codebase AGENTS.md)',
      },
    ]);
  });
});
