import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import * as fsAdapter from "../../../src/adapters/fs/index.ts";
import { main } from "../../../src/cli/index.ts";
import { renderCodebaseConfig } from "../../../src/domain/codebase-config.ts";
import { transaction } from "../../../src/runners/transaction.ts";
import { writeCodebaseFiles } from "../../../src/services/codebase-init.ts";
import { withFault } from "../../helpers/faults.ts";
import { git, makeRepos } from "../../helpers/git.ts";
import { type Isolation, isolate, writeFile } from "../../helpers/isolate.ts";

let iso: Isolation;
let codebase: string;
let configFile: string;
let agentsFile: string;
let spies: { mockRestore(): void }[];

beforeEach(() => {
  iso = isolate();
  codebase = join(iso.root, "shop");
  mkdirSync(codebase);
  configFile = join(codebase, ".crossrepo", "config.yaml");
  agentsFile = join(codebase, "AGENTS.md");
  spies = [];
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  iso.restore();
});

function testEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  return env;
}

async function run(
  argv: string[],
  {
    cwd = codebase,
    env = testEnv(),
  }: { cwd?: string; env?: Record<string, string | undefined> } = {},
) {
  let stdout = "";
  let stderr = "";
  const code = await main({
    version: "1.2.3",
    argv,
    env,
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

async function json(argv: string[], options?: Parameters<typeof run>[1]) {
  const result = await run(["--json", ...argv], options);
  return { ...result, data: JSON.parse(result.stdout) };
}

/** Makes `createFs` give a wrapped adapter for the rest of the test. */
function fakeFs(wrap: (fs: fsAdapter.Fs) => fsAdapter.Fs) {
  const real = fsAdapter.createFs;
  spies.push(
    spyOn(fsAdapter, "createFs").mockImplementation((platform) =>
      wrap(real(platform)),
    ),
  );
}

function expectUntouched() {
  expect(existsSync(join(codebase, ".crossrepo"))).toBe(false);
  expect(existsSync(agentsFile)).toBe(false);
}

describe("xr codebase init", () => {
  test("--json gives the codebase and the added repos, sorted by name", async () => {
    const remotes = makeRepos(codebase, { web: {}, api: { branch: "trunk" } });
    const result = await run(["--json", "codebase", "init"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      `${JSON.stringify({
        ok: true,
        warnings: [],
        codebase,
        added: [
          { repo: "api", remote: remotes.api, defaultBranch: "trunk" },
          { repo: "web", remote: remotes.web, defaultBranch: "main" },
        ],
      })}\n`,
    );
    expect(readFileSync(configFile, "utf8")).toBe(
      renderCodebaseConfig([
        { name: "api", remote: remotes.api as string, defaultBranch: "trunk" },
        { name: "web", remote: remotes.web as string, defaultBranch: "main" },
      ]),
    );
    const agents = readFileSync(agentsFile, "utf8");
    expect(agents).toStartWith("## Codebase\n");
    expect(agents).toContain("- `api`\n- `web`\n");
  });

  test("text mode prints one line per repo and the steps on stderr, then the codebase and the repos on stdout", async () => {
    const remotes = makeRepos(codebase, { api: {}, web: {} });
    const result = await run(["codebase", "init"]);
    expect(result.code).toBe(0);
    expect(result.stderr.split("\n")).toEqual([
      "✓ api: main",
      "✓ web: main",
      "Create .crossrepo/…",
      "✓ Create .crossrepo/",
      "Write .crossrepo/config.yaml…",
      "✓ Write .crossrepo/config.yaml",
      "Write AGENTS.md…",
      "✓ Write AGENTS.md",
      "",
    ]);
    expect(result.stdout).toBe(
      [
        codebase,
        "",
        `api  ${remotes.api}  main`,
        `web  ${remotes.web}  main`,
        "",
      ].join("\n"),
    );
  });

  test("keeps the old AGENTS.md text around the new section", async () => {
    makeRepos(codebase, { api: {} });
    writeFile(agentsFile, "# Team\n\nBe kind.\n");
    expect((await run(["codebase", "init"])).code).toBe(0);
    const agents = readFileSync(agentsFile, "utf8");
    expect(agents).toStartWith("# Team\n\nBe kind.\n\n## Codebase\n");
  });

  test("the new config loads in xr config show with no warning", async () => {
    const remotes = makeRepos(codebase, { api: {} });
    await run(["codebase", "init"]);
    const show = await json(["config", "show"]);
    expect(show.code).toBe(0);
    expect(show.stderr).toBe("");
    expect(show.data.warnings).toEqual([]);
    expect(show.data.entries).toContainEqual({
      key: "repos.api.remote",
      value: remotes.api,
      source: configFile,
    });
    expect(show.data.entries).toContainEqual({
      key: "repos.api.default-branch",
      value: "main",
      source: configFile,
    });
  });

  test("no repos writes repos: {} and a hint to add one", async () => {
    mkdirSync(join(codebase, "docs"));
    const result = await json(["codebase", "init"]);
    expect(result.code).toBe(0);
    expect(result.data).toEqual({
      ok: true,
      warnings: [],
      codebase,
      added: [],
      notes: [
        "No repos found. Add one with `xr codebase repo add <url>|<folder>`.",
      ],
    });
    expect(readFileSync(configFile, "utf8")).toContain("repos: {}\n");
    expect(readFileSync(agentsFile, "utf8")).toContain("- none\n");
    const text = await run(["codebase", "init"], {
      cwd: join(codebase, "docs"),
    });
    expect(text.stdout).toContain("xr codebase repo add <url>|<folder>");
  });

  test("a .git in the codebase folder itself is ignored", async () => {
    git(codebase, "init", "--quiet");
    makeRepos(codebase, { api: {} });
    const result = await json(["codebase", "init"]);
    expect(result.code).toBe(0);
    expect(
      result.data.added.map((item: { repo: string }) => item.repo),
    ).toEqual(["api"]);
  });

  test("--codebase-path picks the folder", async () => {
    makeRepos(codebase, { api: {} });
    const result = await json(
      ["--codebase-path", codebase, "codebase", "init"],
      {
        cwd: iso.home,
      },
    );
    expect(result.code).toBe(0);
    expect(existsSync(configFile)).toBe(true);
  });

  test("xr codebase with no subcommand prints its help", async () => {
    const result = await run(["codebase"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: xr codebase");
    expect(result.stdout).toContain("init");
  });
});

describe("xr codebase init refuses", () => {
  test("repos with no origin or no origin/HEAD: repos-not-ready lists each, nothing written", async () => {
    makeRepos(codebase, { a: { origin: false }, b: { head: false }, c: {} });
    const result = await json(["codebase", "init"]);
    expect(result.code).toBe(1);
    expect(result.data.ok).toBe(false);
    expect(result.data.error.code).toBe("repos-not-ready");
    expect(result.data.error.hint).toContain("xr codebase init");
    expect(result.data.error.details).toEqual({
      repos: [
        {
          repo: "a",
          problem: "no origin remote",
          fix: `git -C "${join(codebase, "a")}" remote add origin <url>`,
        },
        {
          repo: "b",
          problem: "no origin/HEAD",
          fix: `git -C "${join(codebase, "b")}" remote set-head origin --auto`,
        },
      ],
    });
    expectUntouched();
    const text = await run(["codebase", "init"]);
    expect(text.stdout).toBe("");
    expect(text.stderr).toContain("✗ a: no origin remote");
    expect(text.stderr).toContain("remote set-head origin --auto");
  });

  test("a codebase: already-a-codebase with hints, nothing changes", async () => {
    writeFile(configFile, "name: shop\n");
    const result = await json(["codebase", "init"]);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("already-a-codebase");
    expect(result.data.error.hint).toContain("xr codebase repo add");
    expect(result.data.error.hint).toContain(
      "delete `.crossrepo/config.yaml`, then run `xr codebase init`",
    );
    expect(readFileSync(configFile, "utf8")).toBe("name: shop\n");
    expect(existsSync(agentsFile)).toBe(false);
  });

  test("a codebase with config.yml names that file in the hint", async () => {
    writeFile(join(codebase, ".crossrepo", "config.yml"), "");
    const result = await json(["codebase", "init"]);
    expect(result.data.error.hint).toContain("delete `.crossrepo/config.yml`");
  });

  test("a .crossrepo/ folder with no config: already-a-codebase with a hint to delete it", async () => {
    writeFile(join(codebase, ".crossrepo", "config.local.yaml"), "");
    makeRepos(codebase, { api: {} });
    const result = await json(["codebase", "init"]);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("already-a-codebase");
    expect(result.data.error.hint).toContain(
      "delete `.crossrepo/`, then run `xr codebase init`",
    );
    expect(existsSync(configFile)).toBe(false);
  });

  test("a .crossrepo/ folder with a broken local config and no config: already-a-codebase", async () => {
    writeFile(join(codebase, ".crossrepo", "config.local.yaml"), "name: [\n");
    const result = await json(["codebase", "init"]);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("already-a-codebase");
  });

  test("a project: inside-a-project, nothing changes", async () => {
    writeFile(configFile, "");
    const project = join(codebase, ".projects", "feat");
    writeFile(join(project, ".crossrepo", "project.yaml"), "codebase: ../..\n");
    const result = await json(["codebase", "init"], { cwd: project });
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("inside-a-project");
    expect(existsSync(join(project, ".crossrepo", "config.yaml"))).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "git older than 2.27: git-too-old with the version, nothing written",
    async () => {
      makeRepos(codebase, { api: {} });
      const bin = join(iso.root, "bin");
      const script = writeFile(
        join(bin, "git"),
        '#!/bin/sh\necho "git version 2.20.1"\n',
      );
      chmodSync(script, 0o755);
      const env = {
        ...testEnv(),
        PATH: [bin, process.env.PATH].join(delimiter),
      };
      const result = await json(["codebase", "init"], { env });
      expect(result.code).toBe(1);
      expect(result.data.error.code).toBe("git-too-old");
      expect(result.data.error.message).toContain("2.20.1");
      expect(result.data.error.hint).toContain("Upgrade git");
      expectUntouched();
    },
  );

  test("a broken repo is git-failed, nothing written", async () => {
    writeFile(join(codebase, "bad", ".git"), "gitdir: ../nowhere\n");
    const result = await json(["codebase", "init"]);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("git-failed");
    expectUntouched();
  });
});

describe("xr codebase init undo", () => {
  for (const [step, method, nth] of [
    ["Create .crossrepo/", "mkdir", 1],
    ["Write .crossrepo/config.yaml", "writeText", 1],
    ["Write AGENTS.md", "writeText", 2],
  ] as const) {
    test(`a fault at "${step}" undoes the done steps and fails with the step error`, async () => {
      makeRepos(codebase, { api: {} });
      fakeFs((fs) => withFault(fs, method, nth));
      const result = await json(["codebase", "init"]);
      expect(result.code).toBe(1);
      expect(result.data.error.code).toBe("internal");
      expect(result.data.error.message).toBe(`fault in ${method} call ${nth}`);
      expect(result.stderr).toContain(`✗ ${step}`);
      expectUntouched();
    });
  }

  test("an old AGENTS.md stays as it was after a fault", async () => {
    makeRepos(codebase, { api: {} });
    writeFile(agentsFile, "# Team\n");
    fakeFs((fs) => withFault(fs, "writeText", 2));
    expect((await run(["codebase", "init"])).code).toBe(1);
    expect(readFileSync(agentsFile, "utf8")).toBe("# Team\n");
    expect(existsSync(join(codebase, ".crossrepo"))).toBe(false);
  });

  test("a failed undo lists leftovers and the other undos still run", async () => {
    makeRepos(codebase, { api: {} });
    fakeFs((fs) => withFault(withFault(fs, "writeText", 2), "remove", 1));
    const result = await json(["codebase", "init"]);
    expect(result.code).toBe(1);
    expect(result.data.error.hint).toContain("--verbose");
    const folder = join(codebase, ".crossrepo");
    expect(result.data.error.details).toEqual({
      leftovers: [
        {
          what: ".crossrepo folder",
          path: folder,
          command: `rm -r "${folder}"`,
        },
      ],
    });
    expect(existsSync(configFile)).toBe(true);
  });

  test("a failed folder undo is the only leftover, with no stale config file", async () => {
    makeRepos(codebase, { api: {} });
    fakeFs((fs) => withFault(withFault(fs, "writeText", 2), "remove", 1));
    const text = await run(["codebase", "init"]);
    expect(text.code).toBe(1);
    const folder = join(codebase, ".crossrepo");
    expect(text.stderr).toContain(
      `.crossrepo folder: ${folder}\n  rm -r "${folder}"\n`,
    );
    expect(text.stderr).not.toContain("config file");
  });
});

describe("writeCodebaseFiles undo", () => {
  const repos = [{ name: "api", remote: "/o/api.git", defaultBranch: "main" }];
  const ctx = () => ({ out: { emit() {} }, fs: fsAdapter.createFs() });

  test("puts the old AGENTS.md text back", async () => {
    writeFile(agentsFile, "# Team\n");
    const failed = transaction(ctx(), async (tx) => {
      await writeCodebaseFiles(ctx(), tx, codebase, repos);
      throw new Error("later");
    });
    await expect(failed).rejects.toThrow("later");
    expect(readFileSync(agentsFile, "utf8")).toBe("# Team\n");
    expect(existsSync(join(codebase, ".crossrepo"))).toBe(false);
  });

  test("removes an AGENTS.md it made", async () => {
    const failed = transaction(ctx(), async (tx) => {
      await writeCodebaseFiles(ctx(), tx, codebase, repos);
      throw new Error("later");
    });
    await expect(failed).rejects.toThrow("later");
    expectUntouched();
  });

  test("a failed AGENTS.md undo gives a leftover for it", async () => {
    writeFile(agentsFile, "# Team\n");
    const broken = {
      out: { emit() {} },
      fs: withFault(fsAdapter.createFs(), "writeText", 3),
    };
    const failed = await transaction(broken, async (tx) => {
      await writeCodebaseFiles(broken, tx, codebase, repos);
      throw new Error("later");
    }).catch((error: unknown) => error);
    expect((failed as { blocks: unknown[] }).blocks).toEqual([
      {
        type: "leftovers",
        items: [
          {
            what: "AGENTS.md",
            path: { path: agentsFile },
            command: {
              code: "Remove the `## Codebase` section from AGENTS.md by hand.",
            },
          },
        ],
      },
    ]);
  });
});
