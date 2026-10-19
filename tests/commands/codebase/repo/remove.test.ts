import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as fsAdapter from "../../../../src/adapters/fs/index.ts";
import * as gitAdapter from "../../../../src/adapters/git/index.ts";
import * as promptAdapter from "../../../../src/adapters/prompt/index.ts";
import { main } from "../../../../src/cli/index.ts";
import {
  removeRepoEntry,
  renderCodebaseConfig,
} from "../../../../src/domain/codebase-config.ts";
import { afterCall, withFault } from "../../../helpers/faults.ts";
import { git, makeRepos } from "../../../helpers/git.ts";
import {
  type FakeInterrupts,
  fakeInterrupts,
} from "../../../helpers/interrupts.ts";
import {
  type Isolation,
  isolate,
  writeFile,
} from "../../../helpers/isolate.ts";
import { fakeKeys, fakePick } from "../../../helpers/prompt.ts";

let iso: Isolation;
let codebase: string;
let configFile: string;
let agentsFile: string;
let lockFile: string;
let apiDir: string;
let spies: { mockRestore(): void }[];
let interrupts: FakeInterrupts;

const REMOVE = ["codebase", "repo", "remove"];
const AGENTS_BEFORE = "# Team\n\nBe kind.\n";

beforeEach(() => {
  iso = isolate();
  codebase = join(iso.root, "shop");
  mkdirSync(codebase);
  configFile = join(codebase, ".crossrepo", "config.yaml");
  agentsFile = join(codebase, "AGENTS.md");
  lockFile = join(codebase, ".crossrepo", "xr.lock");
  apiDir = join(codebase, "api");
  spies = [];
  interrupts = fakeInterrupts();
  const remotes = makeRepos(codebase, { api: {}, web: {} });
  writeFile(
    configFile,
    renderCodebaseConfig([
      { name: "api", remote: remotes.api as string, defaultBranch: "main" },
      { name: "web", remote: remotes.web as string, defaultBranch: "main" },
    ]),
  );
  writeFile(agentsFile, AGENTS_BEFORE);
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
  { cwd = codebase, tty = false }: { cwd?: string; tty?: boolean } = {},
) {
  let stdout = "";
  let stderr = "";
  const code = await main({
    version: "1.2.3",
    argv,
    env: testEnv(),
    isTTY: { stdin: tty, stdout: tty, stderr: false },
    cwd,
    home: iso.home,
    interrupts,
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

/** Makes `createGit` give a wrapped adapter for the rest of the test. */
function fakeGit(wrap: (git: gitAdapter.Git) => gitAdapter.Git) {
  const real = gitAdapter.createGit;
  spies.push(
    spyOn(gitAdapter, "createGit").mockImplementation((options) =>
      wrap(real(options)),
    ),
  );
}

/** Fails the test when the loss check runs. */
function noLossCheck() {
  fakeGit((git) => ({
    ...git,
    lossCheck: () => Promise.reject(new Error("the loss check ran")),
  }));
}

/** The config, AGENTS.md and the api folder, to check that a failed run changed nothing. */
function state() {
  return {
    config: readFileSync(configFile, "utf8"),
    agents: readFileSync(agentsFile, "utf8"),
    api: existsSync(join(apiDir, ".git")),
  };
}

function project(
  name: string,
  text: string,
  dir = join(codebase, ".projects"),
) {
  return writeFile(join(dir, name, ".crossrepo", "project.yaml"), text);
}

const leftovers = {
  config: (file = configFile) => ({
    what: "config file",
    path: file,
    command: `Remove the \`api\` entry from \`repos:\` in ${file} by hand.`,
  }),
  agents: () => ({
    what: "AGENTS.md",
    path: agentsFile,
    command:
      "Run `xr codebase repo list`, then remove `api` from the `## Codebase` section of AGENTS.md by hand.",
  }),
  folder: () => ({
    what: "repo folder",
    path: apiDir,
    command: `rm -rf "${apiDir}"`,
  }),
};

describe("xr codebase repo remove <name>", () => {
  test("--json removes the entry, the ## Codebase line and the clean folder", async () => {
    const before = readFileSync(configFile, "utf8");
    const result = await run(["--json", ...REMOVE, "api"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      `${JSON.stringify({
        ok: true,
        warnings: [],
        removed: "api",
        folderDeleted: true,
      })}\n`,
    );
    expect(readFileSync(configFile, "utf8")).toBe(
      removeRepoEntry(before, "api"),
    );
    const agents = readFileSync(agentsFile, "utf8");
    expect(agents).toStartWith(`${AGENTS_BEFORE}\n## Codebase\n`);
    expect(agents).toContain("- `web`\n");
    expect(agents).not.toContain("`api`");
    expect(existsSync(apiDir)).toBe(false);
    expect(existsSync(join(codebase, "web", ".git"))).toBe(true);
    expect(existsSync(lockFile)).toBe(false);
  });

  test("text mode prints the steps on stderr and the result on stdout", async () => {
    const result = await run([...REMOVE, "api"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("✓ Write .crossrepo/config.yaml\n");
    expect(result.stderr).toContain("✓ Write AGENTS.md\n");
    expect(result.stderr).toContain("✓ Delete api/\n");
    expect(result.stdout).toBe("api\n\nfolderDeleted: true\n");
  });

  test("--keep-folder keeps a dirty folder and runs no loss check", async () => {
    writeFile(join(apiDir, "work.txt"), "mine");
    noLossCheck();
    const result = await json([...REMOVE, "api", "--keep-folder"]);
    expect(result.code).toBe(0);
    expect(result.data).toEqual({
      ok: true,
      warnings: [],
      removed: "api",
      folderDeleted: false,
    });
    expect(readFileSync(join(apiDir, "work.txt"), "utf8")).toBe("mine");
    expect(readFileSync(configFile, "utf8")).not.toContain("  api:");
    expect(result.stderr).not.toContain("Delete");
  });

  test("--force deletes a dirty folder with no loss check", async () => {
    writeFile(join(apiDir, "work.txt"), "mine");
    git(apiDir, "commit", "--quiet", "--allow-empty", "-m", "local");
    noLossCheck();
    const result = await json([...REMOVE, "--force", "api"]);
    expect(result.code).toBe(0);
    expect(result.data.folderDeleted).toBe(true);
    expect(existsSync(apiDir)).toBe(false);
  });

  test("a missing folder: the entry goes, folderDeleted false", async () => {
    fsAdapter.createFs().remove(apiDir);
    const result = await json([...REMOVE, "api"]);
    expect(result.code).toBe(0);
    expect(result.data.folderDeleted).toBe(false);
    expect(readFileSync(configFile, "utf8")).not.toContain("  api:");
    expect(result.stderr).not.toContain("Delete");
  });

  test("a key with a null value is removed like any entry", async () => {
    writeFile(configFile, "repos:\n  api:\n  web:\n    remote: /o/web.git\n");
    const result = await json([...REMOVE, "api"]);
    expect(result.code).toBe(0);
    expect(result.data.folderDeleted).toBe(true);
    expect(readFileSync(configFile, "utf8")).toBe(
      "repos:\n  web:\n    remote: /o/web.git\n",
    );
    expect(existsSync(apiDir)).toBe(false);
  });

  test("the last repo leaves repos: {}", async () => {
    await json([...REMOVE, "web"]);
    const result = await json([...REMOVE, "api"]);
    expect(result.code).toBe(0);
    expect(readFileSync(configFile, "utf8")).toBe(renderCodebaseConfig([]));
  });

  test("an ignored file is not work to lose", async () => {
    writeFile(join(apiDir, ".git", "info", "exclude"), "*.log\n");
    writeFile(join(apiDir, "debug.log"), "x");
    const result = await json([...REMOVE, "api"]);
    expect(result.code).toBe(0);
    expect(existsSync(apiDir)).toBe(false);
  });

  test("a .yml config is edited in place and no .yaml is made", async () => {
    const yml = join(codebase, ".crossrepo", "config.yml");
    writeFileSync(yml, readFileSync(configFile, "utf8"));
    await Bun.file(configFile).delete();
    const result = await json([...REMOVE, "api"]);
    expect(result.code).toBe(0);
    expect(readFileSync(yml, "utf8")).not.toContain("  api:");
    expect(readFileSync(yml, "utf8")).toContain("  web:");
    expect(existsSync(configFile)).toBe(false);
  });

  test("config.local.yaml is never touched", async () => {
    const local = join(codebase, ".crossrepo", "config.local.yaml");
    const text = "# mine\nrepos:\n  api:\n    remote: /x/api.git\n";
    writeFile(local, text);
    expect((await run([...REMOVE, "api"])).code).toBe(0);
    expect(readFileSync(local, "utf8")).toBe(text);
  });

  test.skipIf(process.platform === "win32")(
    "a symlinked config.yaml is written through and stays a symlink",
    async () => {
      const real = join(iso.root, "dotfiles", "shop.yaml");
      writeFile(real, readFileSync(configFile, "utf8"));
      await Bun.file(configFile).delete();
      symlinkSync(real, configFile);
      expect((await run([...REMOVE, "api"])).code).toBe(0);
      expect(lstatSync(configFile).isSymbolicLink()).toBe(true);
      expect(readFileSync(real, "utf8")).not.toContain("  api:");
    },
  );

  test("the new config loads in xr repo list", async () => {
    await run([...REMOVE, "api"]);
    const list = await json(["codebase", "repo", "list"]);
    expect(
      list.data.entries.map((entry: { repo: string }) => entry.repo),
    ).toEqual(["web"]);
  });
});

describe("xr codebase repo remove keys that are not a folder name", () => {
  for (const key of ["..", "a/b"]) {
    test(`the key ${key}: the entry goes, the folder at that path is never deleted`, async () => {
      const folder = join(codebase, key);
      mkdirSync(join(folder, ".git"), { recursive: true });
      writeFile(
        configFile,
        `repos:\n  ${JSON.stringify(key)}:\n  web:\n    remote: /o/web.git\n`,
      );
      fakeGit((git) => ({
        ...git,
        version: () => Promise.reject(new Error("git ran")),
        lossCheck: () => Promise.reject(new Error("git ran")),
      }));
      const result = await json([...REMOVE, key, "--force"]);
      expect(result.code).toBe(0);
      expect(result.data.folderDeleted).toBe(false);
      expect(existsSync(join(folder, ".git"))).toBe(true);
      expect(readFileSync(configFile, "utf8")).toBe(
        "repos:\n  web:\n    remote: /o/web.git\n",
      );
    });
  }
});

describe("xr codebase repo remove with no name", () => {
  test("in a terminal: picks from the codebase file's repos in config order, then removes", async () => {
    writeFile(
      configFile,
      "repos:\n  web:\n    remote: /o/web.git\n  api:\n    remote: /o/api.git\n",
    );
    writeFile(
      join(codebase, ".crossrepo", "config.local.yaml"),
      "repos:\n  mine:\n    remote: /x/mine.git\n",
    );
    const requests = fakePick(spies, "web");
    const result = await run(REMOVE, { tty: true });
    expect(result.code).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      argument: "name",
      message: "Pick the repo to remove",
      choices: ["web", "api"],
    });
    expect(readFileSync(configFile, "utf8")).not.toContain("  web:");
    expect(readFileSync(configFile, "utf8")).toContain("  api:");
    expect(existsSync(join(codebase, "web"))).toBe(false);
    expect(existsSync(lockFile)).toBe(false);
  });

  test("in a terminal: the picked name keeps the flags", async () => {
    fakePick(spies, "web");
    const result = await run([...REMOVE, "--keep-folder"], { tty: true });
    expect(result.code).toBe(0);
    expect(readFileSync(configFile, "utf8")).not.toContain("  web:");
    expect(existsSync(join(codebase, "web", ".git"))).toBe(true);
  });

  for (const [mode, argv, tty] of [
    ["no TTY", REMOVE, false],
    ["--json", ["--json", ...REMOVE], true],
    ["--no-interactive", ["--no-interactive", "--json", ...REMOVE], true],
  ] as const) {
    test(`${mode}: missing-argument with the choices, exit 2, before the lock`, async () => {
      writeFile(lockFile, `${process.ppid}\n`);
      const before = state();
      const result = await run([...argv], { tty });
      expect(result.code).toBe(2);
      if (mode === "no TTY") {
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(
          "Give the name of the repo to remove. Choices: api, web.",
        );
        expect(result.stderr).toContain("xr codebase repo remove <name>");
      } else {
        expect(JSON.parse(result.stdout).error).toEqual({
          code: "missing-argument",
          message: "Give the name of the repo to remove. Choices: api, web.",
          hint: "xr codebase repo remove <name>",
          details: { argument: "name", choices: ["api", "web"] },
        });
      }
      expect(state()).toEqual(before);
    });
  }

  test("--no-interactive in text mode: missing-argument, stdout stays empty", async () => {
    const result = await run(["--no-interactive", ...REMOVE], { tty: true });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Choices: api, web.");
  });

  test("no repos, --json: missing-argument with no choices", async () => {
    writeFile(configFile, renderCodebaseConfig([]));
    const result = await json(REMOVE);
    expect(result.code).toBe(2);
    expect(result.data.error).toEqual({
      code: "missing-argument",
      message: "There is no repo to remove.",
      hint: "xr codebase repo add <url>|<folder>",
      details: { argument: "name", choices: [] },
    });
  });

  for (const tty of [true, false]) {
    test(`no repos, tty ${tty}: missing-argument in text mode, no picker`, async () => {
      writeFile(configFile, renderCodebaseConfig([]));
      fakeKeys(spies, []);
      const text = await run(REMOVE, { tty });
      expect(text.code).toBe(2);
      expect(text.stdout).toBe("");
      expect(text.stderr).toContain("There is no repo to remove.");
    });
  }

  for (const [name, key] of [
    ["Escape", "\x1b"],
    ["Ctrl-C", "\x03"],
  ] as const) {
    test(`${name} in the picker: interrupted, exit 130, nothing changes`, async () => {
      fakeKeys(spies, [key]);
      const before = state();
      const result = await run(REMOVE, { tty: true });
      expect(result.code).toBe(130);
      expect(result.stderr).toContain("Stopped by Ctrl-C.");
      expect(state()).toEqual(before);
      expect(existsSync(join(codebase, "web", ".git"))).toBe(true);
      expect(existsSync(lockFile)).toBe(false);
    });
  }

  test("a picker with the real adapter: Enter picks the first repo", async () => {
    fakeKeys(spies, ["\r"]);
    const result = await run(REMOVE, { tty: true });
    expect(result.code).toBe(0);
    expect(existsSync(apiDir)).toBe(false);
  });

  test("a given name never opens a picker", async () => {
    spies.push(
      spyOn(promptAdapter, "createPrompt").mockImplementation(() => ({
        pick: () => Promise.reject(new Error("the picker opened")),
      })),
    );
    const result = await run([...REMOVE, "web"], { tty: true });
    expect(result.code).toBe(0);
    expect(existsSync(join(codebase, "web"))).toBe(false);
  });
});

describe("xr codebase repo remove usage", () => {
  test("an empty name: usage, exit 2", async () => {
    const before = state();
    const result = await json([...REMOVE, ""]);
    expect(result.code).toBe(2);
    expect(result.data.error.code).toBe("usage");
    expect(state()).toEqual(before);
  });

  test("two names: usage, exit 2", async () => {
    const before = state();
    const result = await json([...REMOVE, "api", "web"]);
    expect(result.code).toBe(2);
    expect(result.data.error.code).toBe("usage");
    expect(state()).toEqual(before);
  });

  test("--help names the two options", async () => {
    const result = await run([...REMOVE, "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: xr codebase repo remove");
    expect(result.stdout).toContain("--keep-folder");
    expect(result.stdout).toContain("--force");
  });

  test("a project folder: not-a-codebase", async () => {
    const dir = join(codebase, ".projects", "feat");
    project("feat", "codebase: ../..\nrepos: []\n");
    const result = await json([...REMOVE, "api"], { cwd: dir });
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("not-a-codebase");
  });
});

describe("xr codebase repo remove refuses", () => {
  test("an unknown name: repo-not-found with the list hint, nothing changes", async () => {
    const before = state();
    const result = await json([...REMOVE, "nope"]);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("repo-not-found");
    expect(result.data.error.hint).toContain("xr codebase repo list");
    expect(state()).toEqual(before);
    expect(existsSync(lockFile)).toBe(false);
  });

  test("a name only in config.local.yaml: repo-not-found, the file is not touched", async () => {
    const local = writeFile(
      join(codebase, ".crossrepo", "config.local.yaml"),
      "repos:\n  mine:\n    remote: /x/mine.git\n",
    );
    const before = state();
    const result = await json([...REMOVE, "mine"]);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("repo-not-found");
    expect(result.data.error.hint).toContain("config.local");
    expect(result.data.error.hint).toContain("xr codebase repo list");
    expect(readFileSync(local, "utf8")).toBe(
      "repos:\n  mine:\n    remote: /x/mine.git\n",
    );
    expect(state()).toEqual(before);
  });

  for (const flags of [[], ["--force"], ["--keep-folder"]]) {
    test(`a repo used by a project of this codebase: repo-in-use ${flags.join(" ")}`, async () => {
      project("feat-b", "codebase: ../..\nrepos: [api, web]\n");
      project("feat-a", "codebase: ../..\nrepos:\n  api: {}\n");
      project("other", "codebase: ../..\nrepos: [web]\n");
      const before = state();
      const result = await json([...REMOVE, "api", ...flags]);
      expect(result.code).toBe(1);
      expect(result.data.error.code).toBe("repo-in-use");
      expect(result.data.error.message).toContain("feat-a, feat-b");
      expect(result.data.error.details).toEqual({
        projects: ["feat-a", "feat-b"],
      });
      expect(state()).toEqual(before);
      expect(existsSync(lockFile)).toBe(false);
    });
  }

  test.skipIf(process.platform === "win32")(
    "a record that gives this codebase through a symlink matches",
    async () => {
      const link = join(iso.root, "link");
      symlinkSync(codebase, link);
      project("feat", `codebase: ${JSON.stringify(link)}\nrepos: [api]\n`);
      const result = await json([...REMOVE, "api"]);
      expect(result.data.error.code).toBe("repo-in-use");
    },
  );

  test("records of another codebase or of a missing folder do not match", async () => {
    const other = join(iso.root, "other");
    mkdirSync(other);
    project("a", `codebase: ${JSON.stringify(other)}\nrepos: [api]\n`);
    project("b", "codebase: ../../../gone\nrepos: [api]\n");
    mkdirSync(join(codebase, ".projects", "not-a-project"));
    const result = await json([...REMOVE, "api"]);
    expect(result.code).toBe(0);
  });

  test("projects-dir from config.local.yaml, outside the codebase, is scanned", async () => {
    const elsewhere = join(iso.root, "work");
    writeFile(
      join(codebase, ".crossrepo", "config.local.yaml"),
      `projects-dir: ${JSON.stringify(elsewhere)}\n`,
    );
    project(
      "feat",
      `codebase: ${JSON.stringify(codebase)}\nrepos: [api]\n`,
      elsewhere,
    );
    const result = await json([...REMOVE, "api"]);
    expect(result.data.error.code).toBe("repo-in-use");
  });

  test("a missing projects-dir folder means no projects", async () => {
    writeFile(
      join(codebase, ".crossrepo", "config.local.yaml"),
      "projects-dir: ../nowhere\n",
    );
    const result = await json([...REMOVE, "api"]);
    expect(result.code).toBe(0);
  });

  for (const [what, text] of [
    ["bad YAML", "codebase: [\n"],
    ["no repos", "codebase: ../..\n"],
    ["no codebase", "repos: [api]\n"],
    ["a list at the top", "- api\n"],
  ] as const) {
    test(`a record with ${what}: invalid-project-record naming the file`, async () => {
      const file = project("broken", text);
      const before = state();
      const result = await json([...REMOVE, "api"]);
      expect(result.code).toBe(1);
      expect(result.data.error.code).toBe("invalid-project-record");
      expect(result.data.error.message).toContain(file);
      expect(result.data.error.hint).toContain(
        join(codebase, ".projects", "broken"),
      );
      expect(state()).toEqual(before);
    });
  }

  const losses: [string, () => void, Record<string, unknown>, string][] = [
    [
      "an uncommitted change",
      () => writeFile(join(apiDir, "work.txt"), "mine"),
      { uncommitted: ["work.txt"], unpushed: [], stashes: 0 },
      "commit",
    ],
    [
      "an unpushed commit",
      () => git(apiDir, "commit", "--quiet", "--allow-empty", "-m", "local"),
      { uncommitted: [], unpushed: [{ branch: "main", count: 1 }], stashes: 0 },
      "push",
    ],
    [
      "a stash",
      () => {
        writeFile(join(apiDir, "work.txt"), "mine");
        git(apiDir, "stash", "push", "--quiet", "--include-untracked");
      },
      { uncommitted: [], unpushed: [], stashes: 1 },
      "stash list",
    ],
  ];
  for (const [what, make, details, command] of losses) {
    test(`${what}: would-lose-work lists it with its command, nothing changes`, async () => {
      make();
      const before = state();
      const result = await json([...REMOVE, "api"]);
      expect(result.code).toBe(1);
      expect(result.data.error.code).toBe("would-lose-work");
      expect(result.data.error.details).toEqual(details);
      expect(result.data.error.message).toContain(
        `git -C "${apiDir}" ${command}`,
      );
      expect(result.data.error.hint).toContain("--keep-folder");
      expect(result.data.error.hint).toContain("--force");
      expect(state()).toEqual(before);
      expect(existsSync(lockFile)).toBe(false);
    });
  }

  test("would-lose-work in text mode lists every kind on stderr", async () => {
    writeFile(join(apiDir, "work.txt"), "mine");
    git(apiDir, "commit", "--quiet", "--allow-empty", "-m", "local");
    const result = await run([...REMOVE, "api"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("1 uncommitted file (work.txt)");
    expect(result.stderr).toContain("1 commit on main");
    expect(result.stderr).toContain(`git -C "${apiDir}" commit`);
    expect(result.stderr).toContain(`git -C "${apiDir}" push`);
  });

  test("many uncommitted files: the message shows 5 and the count of the rest", async () => {
    for (const n of [1, 2, 3, 4, 5, 6, 7])
      writeFile(join(apiDir, `f${n}.txt`), "x");
    const result = await json([...REMOVE, "api"]);
    expect(result.data.error.message).toContain(
      "7 uncommitted files (f1.txt, f2.txt, f3.txt, f4.txt, f5.txt and 2 more)",
    );
    expect(result.data.error.details.uncommitted).toHaveLength(7);
  });

  for (const flags of [[], ["--force"]]) {
    test(`a folder with no .git: would-lose-work ${flags.join(" ")}, hint --keep-folder, no details`, async () => {
      fsAdapter.createFs().remove(join(apiDir, ".git"));
      writeFile(join(apiDir, "notes.txt"), "mine");
      const before = readFileSync(configFile, "utf8");
      const result = await json([...REMOVE, "api", ...flags]);
      expect(result.code).toBe(1);
      expect(result.data.error.code).toBe("would-lose-work");
      expect(result.data.error.message).toContain(apiDir);
      expect(result.data.error.hint).toContain("--keep-folder");
      expect(result.data.error.details).toBeUndefined();
      expect(readFileSync(configFile, "utf8")).toBe(before);
      expect(readFileSync(join(apiDir, "notes.txt"), "utf8")).toBe("mine");
    });
  }

  test("a folder with no .git and --keep-folder: the entry goes, the folder stays", async () => {
    fsAdapter.createFs().remove(join(apiDir, ".git"));
    const result = await json([...REMOVE, "api", "--keep-folder"]);
    expect(result.code).toBe(0);
    expect(result.data.folderDeleted).toBe(false);
    expect(existsSync(apiDir)).toBe(true);
  });

  test("a held lock wins over every check", async () => {
    writeFile(lockFile, `${process.ppid}\n`);
    const before = state();
    const result = await json([...REMOVE, "nope"]);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("lock-held");
    expect(state()).toEqual(before);
    expect(readFileSync(lockFile, "utf8")).toBe(`${process.ppid}\n`);
  });
});

describe("xr codebase repo remove leftovers", () => {
  test("a fault on the config write: nothing changes, all 3 steps are leftovers", async () => {
    const before = state();
    fakeFs((fs) => withFault(fs, "writeText", 1));
    const result = await json([...REMOVE, "api"]);
    expect(result.code).toBe(1);
    expect(result.data.error.message).toBe("fault in writeText call 1");
    expect(result.data.error.details.leftovers).toEqual([
      leftovers.config(),
      leftovers.agents(),
      leftovers.folder(),
    ]);
    expect(result.stderr).toContain("✗ Write .crossrepo/config.yaml");
    expect(state()).toEqual(before);
    expect(existsSync(lockFile)).toBe(false);
  });

  test("a fault on the AGENTS.md write: the entry is gone, AGENTS.md and the folder are leftovers", async () => {
    const before = state();
    fakeFs((fs) => withFault(fs, "writeText", 2));
    const result = await json([...REMOVE, "api"]);
    expect(result.code).toBe(1);
    expect(result.data.error.details.leftovers).toEqual([
      leftovers.agents(),
      leftovers.folder(),
    ]);
    expect(state()).toEqual({
      ...before,
      config: removeRepoEntry(before.config, "api"),
    });
  });

  test("a fault on the folder delete: entry and ## Codebase line gone, the folder is a leftover", async () => {
    fakeFs((fs) => withFault(fs, "remove", 1));
    const result = await json([...REMOVE, "api"]);
    expect(result.code).toBe(1);
    expect(result.data.error.message).toBe("fault in remove call 1");
    expect(result.data.error.details.leftovers).toEqual([leftovers.folder()]);
    expect(readFileSync(configFile, "utf8")).not.toContain("  api:");
    expect(readFileSync(agentsFile, "utf8")).not.toContain("`api`");
    expect(existsSync(join(apiDir, ".git"))).toBe(true);
    expect(existsSync(lockFile)).toBe(false);
  });

  test("text mode prints the leftovers with their commands", async () => {
    fakeFs((fs) => withFault(fs, "remove", 1));
    const result = await run([...REMOVE, "api"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("repo folder: api\n");
    expect(result.stderr).toContain(`  rm -rf "${apiDir}"\n`);
  });
});

describe("xr codebase repo remove Ctrl-C", () => {
  test("in the loss check: git stops, nothing changes, exit 130", async () => {
    let signalled = false;
    fakeGit((git) => ({
      ...git,
      async lossCheck(dir, options) {
        interrupts.fire();
        signalled = options?.signal?.aborted === true;
        return git.lossCheck(dir, options);
      },
    }));
    const before = state();
    const result = await json([...REMOVE, "api"]);
    expect(result.code).toBe(130);
    expect(result.data.error.code).toBe("interrupted");
    expect(result.data.error.details).toBeUndefined();
    expect(signalled).toBe(true);
    expect(state()).toEqual(before);
    expect(existsSync(lockFile)).toBe(false);
    expect(interrupts.listening).toBe(0);
  });

  test("in the config write: the write ends, then it stops with the other steps as leftovers", async () => {
    const before = state();
    fakeFs((fs) => afterCall(fs, "writeText", 1, () => interrupts.fire()));
    const result = await json([...REMOVE, "api"]);
    expect(result.code).toBe(130);
    expect(result.data.error.code).toBe("interrupted");
    expect(result.data.error.details.leftovers).toEqual([
      leftovers.agents(),
      leftovers.folder(),
    ]);
    expect(state()).toEqual({
      ...before,
      config: removeRepoEntry(before.config, "api"),
    });
    expect(existsSync(lockFile)).toBe(false);
  });
});
