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
import { pathToFileURL } from "node:url";
import * as fsAdapter from "../../../../src/adapters/fs/index.ts";
import * as gitAdapter from "../../../../src/adapters/git/index.ts";
import * as promptAdapter from "../../../../src/adapters/prompt/index.ts";
import { main } from "../../../../src/cli/index.ts";
import {
  addRepoEntry,
  renderCodebaseConfig,
} from "../../../../src/domain/codebase-config.ts";
import { GitError } from "../../../../src/errors/index.ts";
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
let spies: { mockRestore(): void }[];
let interrupts: FakeInterrupts;
/** Bare origins outside the codebase, as `file://` URLs. */
let urls: Record<string, string>;

const ADD = ["codebase", "repo", "add"];
const AGENTS_BEFORE = "# Team\n\nBe kind.\n";

beforeEach(() => {
  iso = isolate();
  codebase = join(iso.root, "shop");
  mkdirSync(codebase);
  configFile = join(codebase, ".crossrepo", "config.yaml");
  agentsFile = join(codebase, "AGENTS.md");
  lockFile = join(codebase, ".crossrepo", "xr.lock");
  spies = [];
  interrupts = fakeInterrupts();
  const remotes = makeRepos(join(iso.root, "upstream"), {
    api: {},
    web: { branch: "trunk" },
  });
  urls = Object.fromEntries(
    Object.entries(remotes).map(([name, path]) => [
      name,
      pathToFileURL(path as string).href,
    ]),
  );
  writeFile(configFile, renderCodebaseConfig([]));
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
  {
    cwd = codebase,
    stderrTTY = false,
    tty = false,
  }: { cwd?: string; stderrTTY?: boolean; tty?: boolean } = {},
) {
  let stdout = "";
  let stderr = "";
  const code = await main({
    version: "1.2.3",
    argv,
    env: testEnv(),
    isTTY: { stdin: tty, stdout: tty, stderr: stderrTTY },
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

/** Fires one Ctrl-C at the first stderr text of git, so the signal stops a live child. */
function interruptGit() {
  const real = gitAdapter.createGit;
  let fired = false;
  spies.push(
    spyOn(gitAdapter, "createGit").mockImplementation((options) =>
      real({
        ...options,
        stderr(text) {
          options.stderr?.(text);
          if (fired) return;
          fired = true;
          interrupts.fire();
        },
      }),
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

/**
 * Child folders of the codebase: `lib` can be picked, `docs` has no `.git`,
 * `api` is in the codebase file and `mine` only in config.local.
 */
function pickableLib() {
  const remotes = makeRepos(codebase, { lib: {}, api: {}, mine: {} });
  mkdirSync(join(codebase, "docs"));
  writeFile(
    configFile,
    renderCodebaseConfig([
      { name: "api", remote: remotes.api as string, defaultBranch: "main" },
    ]),
  );
  writeFile(
    join(codebase, ".crossrepo", "config.local.yaml"),
    `repos:\n  mine:\n    remote: ${JSON.stringify(remotes.mine)}\n`,
  );
  return remotes;
}

/** The config and AGENTS.md text, to check that a failed run changed nothing. */
function files() {
  return {
    config: readFileSync(configFile, "utf8"),
    agents: readFileSync(agentsFile, "utf8"),
  };
}

describe("xr codebase repo add <url>", () => {
  test("--json clones the repo, adds it to the config and AGENTS.md, and gives one row", async () => {
    const before = readFileSync(configFile, "utf8");
    const result = await run(["--json", ...ADD, urls.api as string]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      `${JSON.stringify({
        ok: true,
        warnings: [],
        added: [
          {
            repo: "api",
            remote: urls.api,
            defaultBranch: "main",
            description: "",
            cloned: true,
          },
        ],
      })}\n`,
    );
    expect(result.stderr).toContain("Cloning into");
    expect(existsSync(join(codebase, "api", ".git"))).toBe(true);
    expect(git(join(codebase, "api"), "remote", "get-url", "origin")).toBe(
      `${urls.api}\n`,
    );
    expect(readFileSync(configFile, "utf8")).toBe(
      addRepoEntry(before, {
        name: "api",
        remote: urls.api as string,
        defaultBranch: "main",
      }),
    );
    expect(readFileSync(agentsFile, "utf8")).toStartWith(
      `${AGENTS_BEFORE}\n## Codebase\n`,
    );
    expect(readFileSync(agentsFile, "utf8")).toContain("- `api`\n");
    expect(existsSync(lockFile)).toBe(false);
  });

  test("text mode prints the steps on stderr and one row on stdout", async () => {
    const result = await run([...ADD, urls.web as string]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("✓ Clone web\n");
    expect(result.stderr).toContain("✓ web: trunk\n");
    expect(result.stderr).toContain("✓ Write .crossrepo/config.yaml\n");
    expect(result.stderr).toContain("✓ Write AGENTS.md\n");
    expect(result.stdout).toBe(`web  ${urls.web}  trunk    ✓\n`);
  });

  test("a name gives the folder and the entry name", async () => {
    const result = await json([...ADD, urls.api as string, "svc"]);
    expect(result.code).toBe(0);
    expect(result.data.added[0]).toMatchObject({ repo: "svc", cloned: true });
    expect(existsSync(join(codebase, "svc", ".git"))).toBe(true);
    expect(existsSync(join(codebase, "api"))).toBe(false);
    expect(readFileSync(configFile, "utf8")).toContain("  svc:\n");
  });

  test("keeps the other repos and appends the new one at the end of repos:", async () => {
    const remotes = makeRepos(codebase, { web: {} });
    writeFile(
      configFile,
      renderCodebaseConfig([
        { name: "web", remote: remotes.web as string, defaultBranch: "main" },
      ]),
    );
    expect((await run([...ADD, urls.api as string])).code).toBe(0);
    const config = readFileSync(configFile, "utf8");
    expect(config.indexOf("  web:")).toBeLessThan(config.indexOf("  api:"));
    expect(readFileSync(agentsFile, "utf8")).toContain("- `web`\n- `api`\n");
  });

  test("a .yml config is edited in place and no .yaml is made", async () => {
    const yml = join(codebase, ".crossrepo", "config.yml");
    writeFileSync(yml, readFileSync(configFile, "utf8"));
    await Bun.file(configFile).delete();
    expect((await run([...ADD, urls.api as string])).code).toBe(0);
    expect(readFileSync(yml, "utf8")).toContain("  api:\n");
    expect(existsSync(configFile)).toBe(false);
  });

  test("a repo only in config.local.yaml is not in ## Codebase", async () => {
    writeFile(
      join(codebase, ".crossrepo", "config.local.yaml"),
      "repos:\n  mine:\n    remote: /x/mine.git\n",
    );
    expect((await run([...ADD, urls.api as string])).code).toBe(0);
    const agents = readFileSync(agentsFile, "utf8");
    expect(agents).toContain("- `api`\n");
    expect(agents).not.toContain("mine");
  });

  test("## Codebase lists the repos of the written config, with their descriptions", async () => {
    writeFile(
      configFile,
      "repos:\n  web:\n    remote: /o/web.git\n    description: The site\n",
    );
    expect((await run([...ADD, urls.api as string])).code).toBe(0);
    expect(readFileSync(agentsFile, "utf8")).toContain(
      "- `web` — The site\n- `api`\n",
    );
  });

  test("passes progress: true to git only when stderr is a TTY", async () => {
    const real = gitAdapter.createGit;
    const seen: (boolean | undefined)[] = [];
    spies.push(
      spyOn(gitAdapter, "createGit").mockImplementation((options) => {
        seen.push(options.progress);
        return real(options);
      }),
    );
    await run(ADD, { stderrTTY: true });
    await run(ADD);
    expect(seen).toEqual([true, false]);
  });

  test("config.local.yaml is never touched", async () => {
    const local = join(codebase, ".crossrepo", "config.local.yaml");
    const text = "# mine\nrepos:\n  other:\n    remote: /x/other.git\n";
    writeFile(local, text);
    expect((await run([...ADD, urls.api as string])).code).toBe(0);
    expect(readFileSync(local, "utf8")).toBe(text);
    expect(readFileSync(configFile, "utf8")).not.toContain("other");
  });

  test.skipIf(process.platform === "win32")(
    "a symlinked config.yaml is written through and stays a symlink",
    async () => {
      const real = join(iso.root, "dotfiles", "shop.yaml");
      writeFile(real, readFileSync(configFile, "utf8"));
      await Bun.file(configFile).delete();
      symlinkSync(real, configFile);
      expect((await run([...ADD, urls.api as string])).code).toBe(0);
      expect(lstatSync(configFile).isSymbolicLink()).toBe(true);
      expect(readFileSync(real, "utf8")).toContain("  api:\n");
    },
  );

  test("the new config loads in xr repo list", async () => {
    await run([...ADD, urls.api as string]);
    const list = await json(["codebase", "repo", "list"]);
    expect(list.data.entries).toEqual([
      {
        repo: "api",
        remote: urls.api,
        defaultBranch: "main",
        description: "",
        present: true,
      },
    ]);
  });
});

describe("xr codebase repo add <folder>", () => {
  test("adopts a repo directly in the codebase and clones nothing", async () => {
    const remotes = makeRepos(codebase, { web: { branch: "trunk" } });
    const result = await json([...ADD, "./web"]);
    expect(result.code).toBe(0);
    expect(result.data.added).toEqual([
      {
        repo: "web",
        remote: remotes.web,
        defaultBranch: "trunk",
        description: "",
        cloned: false,
      },
    ]);
    expect(result.stderr).not.toContain("Clone");
    expect(readFileSync(configFile, "utf8")).toContain("  web:\n");
    expect(readFileSync(agentsFile, "utf8")).toContain("- `web`\n");
  });

  test("a relative path resolves against the folder where xr runs", async () => {
    makeRepos(codebase, { web: {} });
    const result = await json(
      ["--codebase-path", codebase, ...ADD, join("shop", "web")],
      { cwd: iso.root },
    );
    expect(result.code).toBe(0);
    expect(result.data.added[0]).toMatchObject({ repo: "web", cloned: false });
  });

  test("text mode shows – for cloned", async () => {
    const remotes = makeRepos(codebase, { web: {} });
    const result = await run([...ADD, join(codebase, "web")]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`web  ${remotes.web}  main    –\n`);
  });
});

describe("xr codebase repo add with no argument", () => {
  test("in a terminal: picks a child repo folder not in repos, then adopts it", async () => {
    const remotes = pickableLib();
    const requests = fakePick(spies, "lib");
    // xr runs outside the codebase, so the picked folder must be made absolute.
    const result = await run(["--codebase-path", codebase, ...ADD], {
      cwd: iso.root,
      tty: true,
    });
    expect(result.code).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      argument: "folder",
      message: "Pick the folder to add",
      choices: ["lib"],
    });
    expect(readFileSync(configFile, "utf8")).toContain(
      `  lib:\n    remote: ${remotes.lib}`,
    );
    expect(existsSync(lockFile)).toBe(false);
  });

  test("the choices are sorted by name", async () => {
    makeRepos(codebase, { zeta: {}, alpha: {}, mid: {} });
    const result = await json(ADD);
    expect(result.data.error.details).toEqual({
      argument: "folder",
      choices: ["alpha", "mid", "zeta"],
    });
  });

  for (const [mode, argv, tty] of [
    ["no TTY", ADD, false],
    ["--json", ["--json", ...ADD], true],
    ["--no-interactive", ["--no-interactive", "--json", ...ADD], true],
  ] as const) {
    test(`${mode}: missing-argument with the folders, exit 2, nothing changes`, async () => {
      pickableLib();
      writeFile(lockFile, `${process.ppid}\n`);
      const before = files();
      const result = await run([...argv], { tty });
      expect(result.code).toBe(2);
      if (mode === "no TTY") {
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(
          "Give a git URL to clone, or a folder in the codebase to add. Folders: lib.",
        );
      } else {
        expect(JSON.parse(result.stdout).error).toEqual({
          code: "missing-argument",
          message:
            "Give a git URL to clone, or a folder in the codebase to add. Folders: lib.",
          hint: "xr codebase repo add <url> [name] | <folder>",
          details: { argument: "folder", choices: ["lib"] },
        });
      }
      expect(files()).toEqual(before);
    });
  }

  /** Nothing to pick: `api` is in repos and `docs` has no `.git`. */
  function nothingToPick() {
    makeRepos(codebase, { api: {} });
    writeFile(
      configFile,
      renderCodebaseConfig([
        { name: "api", remote: "/o/api.git", defaultBranch: "main" },
      ]),
    );
    mkdirSync(join(codebase, "docs"));
  }

  test("nothing to pick, --json: missing-argument with no choices", async () => {
    nothingToPick();
    const before = files();
    const result = await json(ADD);
    expect(result.code).toBe(2);
    expect(result.data.error).toEqual({
      code: "missing-argument",
      message: "There is no folder to add.",
      hint: "xr codebase repo add <url> [name]",
      details: { argument: "folder", choices: [] },
    });
    expect(files()).toEqual(before);
  });

  for (const tty of [true, false]) {
    test(`nothing to pick, tty ${tty}: missing-argument in text mode, no picker`, async () => {
      nothingToPick();
      fakeKeys(spies, []);
      const before = files();
      const text = await run(ADD, { tty });
      expect(text.code).toBe(2);
      expect(text.stdout).toBe("");
      expect(text.stderr).toContain("There is no folder to add.");
      expect(files()).toEqual(before);
    });
  }

  test("a key with a null value in the codebase file is not a choice", async () => {
    makeRepos(codebase, { api: {}, lib: {} });
    writeFile(configFile, "repos:\n  api:\n");
    const result = await json(ADD);
    expect(result.code).toBe(2);
    expect(result.data.error.details).toEqual({
      argument: "folder",
      choices: ["lib"],
    });
  });

  for (const [name, key] of [
    ["Escape", "\x1b"],
    ["Ctrl-C", "\x03"],
  ] as const) {
    test(`${name} in the picker: interrupted, exit 130, nothing changes`, async () => {
      pickableLib();
      fakeKeys(spies, [key]);
      const before = files();
      const result = await run(ADD, { tty: true });
      expect(result.code).toBe(130);
      expect(result.stderr).toContain("Stopped by Ctrl-C.");
      expect(files()).toEqual(before);
      expect(existsSync(join(codebase, "lib", ".git"))).toBe(true);
      expect(existsSync(lockFile)).toBe(false);
    });
  }

  test("a given URL never opens a picker", async () => {
    pickableLib();
    spies.push(
      spyOn(promptAdapter, "createPrompt").mockImplementation(() => ({
        pick: () => Promise.reject(new Error("the picker opened")),
      })),
    );
    const result = await run([...ADD, urls.web as string], { tty: true });
    expect(result.code).toBe(0);
    expect(existsSync(join(codebase, "web", ".git"))).toBe(true);
  });
});

describe("xr codebase repo add usage errors", () => {
  test("an empty argument: usage, exit 2", async () => {
    const before = files();
    const result = await json([...ADD, ""]);
    expect(result.code).toBe(2);
    expect(result.data.error.code).toBe("usage");
    expect(files()).toEqual(before);
  });

  test("a folder and a name: usage, exit 2, nothing changes", async () => {
    makeRepos(codebase, { web: {} });
    const before = files();
    const result = await json([...ADD, "./web", "x"]);
    expect(result.code).toBe(2);
    expect(result.data.error.code).toBe("usage");
    expect(files()).toEqual(before);
  });

  for (const name of [".x", "a/b", "a\\b", "..", "x..y"]) {
    test(`the name ${JSON.stringify(name)}: usage, exit 2, nothing cloned`, async () => {
      const before = files();
      const result = await json([...ADD, urls.api as string, name]);
      expect(result.code).toBe(2);
      expect(result.data.error.code).toBe("usage");
      expect(files()).toEqual(before);
      expect(existsSync(join(codebase, "api"))).toBe(false);
    });
  }

  test("a URL with no name in it: usage", async () => {
    const result = await json([...ADD, "file:///"]);
    expect(result.code).toBe(2);
    expect(result.data.error.code).toBe("usage");
  });

  test("three arguments: usage", async () => {
    const result = await json([...ADD, urls.api as string, "a", "b"]);
    expect(result.code).toBe(2);
    expect(result.data.error.code).toBe("usage");
  });

  test("--help names the URL and folder forms", async () => {
    const result = await run([...ADD, "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: xr codebase repo add");
    expect(result.stdout).toContain("folder");
  });

  test("a project folder: not-a-codebase", async () => {
    const project = join(codebase, ".projects", "feat");
    writeFile(join(project, ".crossrepo", "project.yaml"), "codebase: ../..\n");
    const result = await json([...ADD, urls.api as string], { cwd: project });
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("not-a-codebase");
  });
});

describe("xr codebase repo add refuses", () => {
  test("a name in repos: repo-exists, exit 1, nothing cloned", async () => {
    writeFile(
      configFile,
      "repos:\n  api:\n    remote: /o/api.git\n    default-branch: main\n",
    );
    const before = files();
    const result = await json([...ADD, urls.api as string]);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("repo-exists");
    expect(files()).toEqual(before);
    expect(existsSync(join(codebase, "api"))).toBe(false);
    expect(existsSync(lockFile)).toBe(false);
  });

  test("a key with a null value is taken too", async () => {
    writeFile(configFile, "repos:\n  api:\n");
    const result = await json([...ADD, urls.api as string]);
    expect(result.data.error.code).toBe("repo-exists");
    expect(readFileSync(configFile, "utf8")).toBe("repos:\n  api:\n");
  });

  test("a name only in config.local.yaml is taken too", async () => {
    writeFile(
      join(codebase, ".crossrepo", "config.local.yaml"),
      "repos:\n  api:\n    remote: /o/api.git\n",
    );
    const result = await json([...ADD, urls.api as string]);
    expect(result.data.error.code).toBe("repo-exists");
  });

  test("an adopted folder whose name is in repos: repo-exists", async () => {
    const remotes = makeRepos(codebase, { web: {} });
    writeFile(
      configFile,
      renderCodebaseConfig([
        { name: "web", remote: remotes.web as string, defaultBranch: "main" },
      ]),
    );
    const result = await json([...ADD, "web"]);
    expect(result.data.error.code).toBe("repo-exists");
    expect(existsSync(join(codebase, "web", ".git"))).toBe(true);
  });

  test("an existing clone target folder: repo-exists, the folder stays", async () => {
    writeFile(join(codebase, "api", "notes.txt"), "mine");
    const before = files();
    const result = await json([...ADD, urls.api as string]);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("repo-exists");
    expect(readFileSync(join(codebase, "api", "notes.txt"), "utf8")).toBe(
      "mine",
    );
    expect(files()).toEqual(before);
  });

  test("the checks run under the lock: a held lock wins over repo-exists", async () => {
    writeFile(configFile, "repos:\n  api:\n");
    writeFile(lockFile, `${process.ppid}\n`);
    const result = await json([...ADD, urls.api as string]);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("lock-held");
    expect(readFileSync(lockFile, "utf8")).toBe(`${process.ppid}\n`);
  });

  test("a lock held by a running process: lock-held, nothing changes", async () => {
    writeFile(lockFile, `${process.ppid}\n`);
    const before = files();
    const result = await json([...ADD, urls.api as string]);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("lock-held");
    expect(files()).toEqual(before);
    expect(existsSync(join(codebase, "api"))).toBe(false);
  });

  test("a folder outside the codebase: not-in-codebase with a hint to move it", async () => {
    makeRepos(join(iso.root, "other"), { web: {} });
    const before = files();
    const result = await json([...ADD, "../other/web"]);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("not-in-codebase");
    expect(result.data.error.hint).toContain("Move");
    expect(files()).toEqual(before);
    expect(existsSync(join(iso.root, "other", "web", ".git"))).toBe(true);
  });

  test("a folder deeper in the codebase, or the codebase itself: not-in-codebase", async () => {
    makeRepos(join(codebase, "group"), { web: {} });
    expect((await json([...ADD, "group/web"])).data.error.code).toBe(
      "not-in-codebase",
    );
    expect((await json([...ADD, "."])).data.error.code).toBe("not-in-codebase");
  });

  test("a folder with no .git: repos-not-ready, problem not a repo", async () => {
    mkdirSync(join(codebase, "docs"));
    const before = files();
    const result = await json([...ADD, "docs"]);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("repos-not-ready");
    expect(result.data.error.hint).toContain("xr codebase repo add");
    expect(result.data.error.details.repos).toEqual([
      { repo: "docs", problem: "not a repo", fix: expect.any(String) },
    ]);
    expect(files()).toEqual(before);
    expect(existsSync(join(codebase, "docs"))).toBe(true);
  });

  test("an adopted repo with no origin or no origin/HEAD: repos-not-ready with the init fixes", async () => {
    makeRepos(codebase, { a: { origin: false }, b: { head: false } });
    const before = files();
    const a = await json([...ADD, "a"]);
    expect(a.code).toBe(1);
    expect(a.data.error.code).toBe("repos-not-ready");
    expect(a.data.error.hint).toContain("xr codebase repo add");
    expect(a.data.error.details.repos).toEqual([
      {
        repo: "a",
        problem: "no origin remote",
        fix: `git -C "${join(codebase, "a")}" remote add origin <url>`,
      },
    ]);
    const b = await json([...ADD, "b"]);
    expect(b.data.error.details.repos).toEqual([
      {
        repo: "b",
        problem: "no origin/HEAD",
        fix: `git -C "${join(codebase, "b")}" remote set-head origin --auto`,
      },
    ]);
    expect(files()).toEqual(before);
    expect(existsSync(join(codebase, "a", ".git"))).toBe(true);
    expect(existsSync(join(codebase, "b", ".git"))).toBe(true);
  });

  test("an empty remote: repos-not-ready, the clone is deleted, nothing changes", async () => {
    const empty = join(iso.root, "empty.git");
    mkdirSync(empty);
    git(empty, "init", "--quiet", "--bare");
    const before = files();
    const result = await json([...ADD, pathToFileURL(empty).href]);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("repos-not-ready");
    expect(result.data.error.details.repos).toEqual([
      expect.objectContaining({ repo: "empty", problem: "no origin/HEAD" }),
    ]);
    expect(existsSync(join(codebase, "empty"))).toBe(false);
    expect(files()).toEqual(before);
    expect(existsSync(lockFile)).toBe(false);
  });

  test("a clone that git refuses: git-failed, no folder left", async () => {
    const before = files();
    const result = await json([
      ...ADD,
      pathToFileURL(join(iso.root, "missing.git")).href,
    ]);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("git-failed");
    expect(existsSync(join(codebase, "missing"))).toBe(false);
    expect(files()).toEqual(before);
  });
});

describe("xr codebase repo add undo", () => {
  for (const [step, nth] of [
    ["Write .crossrepo/config.yaml", 1],
    ["Write AGENTS.md", 2],
  ] as const) {
    test(`a fault at "${step}" deletes the clone and puts the files back`, async () => {
      const before = files();
      fakeFs((fs) => withFault(fs, "writeText", nth));
      const result = await json([...ADD, urls.api as string]);
      expect(result.code).toBe(1);
      expect(result.data.error.message).toBe(`fault in writeText call ${nth}`);
      expect(result.stderr).toContain(`✗ ${step}`);
      expect(existsSync(join(codebase, "api"))).toBe(false);
      expect(files()).toEqual(before);
      expect(existsSync(lockFile)).toBe(false);
    });

    test(`a fault at "${step}" keeps an adopted folder`, async () => {
      makeRepos(codebase, { web: {} });
      const before = files();
      fakeFs((fs) => withFault(fs, "writeText", nth));
      const result = await json([...ADD, "web"]);
      expect(result.code).toBe(1);
      expect(existsSync(join(codebase, "web", ".git"))).toBe(true);
      expect(files()).toEqual(before);
    });
  }

  test("a new AGENTS.md is removed by the undo", async () => {
    await Bun.file(agentsFile).delete();
    fakeFs((fs) => afterCall(fs, "writeText", 2, () => interrupts.fire()));
    const result = await json([...ADD, urls.api as string]);
    expect(result.code).toBe(130);
    expect(existsSync(agentsFile)).toBe(false);
    expect(existsSync(join(codebase, "api"))).toBe(false);
  });

  test("a clone that fails after making its folder: the folder is deleted", async () => {
    const target = join(codebase, "api");
    fakeGit((git) => ({
      ...git,
      async clone(_url, dest) {
        writeFile(join(dest, "partial"), "x");
        throw new GitError({
          args: ["clone"],
          exitCode: 128,
          stderr: "fatal: x",
        });
      },
    }));
    const result = await json([...ADD, urls.api as string]);
    expect(result.data.error.code).toBe("git-failed");
    expect(existsSync(target)).toBe(false);
  });

  test("a folder made by another program before the clone step is kept", async () => {
    const target = join(codebase, "api");
    fakeGit((git) => ({
      ...git,
      // Runs after the repo-exists check and before the clone step.
      async version() {
        writeFile(join(target, "theirs"), "x");
        return git.version();
      },
      async clone() {
        throw new GitError({
          args: ["clone"],
          exitCode: 128,
          stderr: "fatal: destination path 'api' already exists",
        });
      },
    }));
    const result = await json([...ADD, urls.api as string]);
    expect(result.data.error.code).toBe("git-failed");
    expect(readFileSync(join(target, "theirs"), "utf8")).toBe("x");
  });

  test("a failed clone undo lists the clone as a leftover", async () => {
    fakeFs((fs) => withFault(withFault(fs, "writeText", 1), "remove", 1));
    const result = await json([...ADD, urls.api as string]);
    expect(result.code).toBe(1);
    const dir = join(codebase, "api");
    expect(result.data.error.details.leftovers).toEqual([
      { what: "cloned repo", path: dir, command: `rm -r "${dir}"` },
    ]);
  });
});

describe("xr codebase repo add Ctrl-C", () => {
  test("during git clone: git stops, the folder is deleted, exit 130", async () => {
    const before = files();
    interruptGit();
    const result = await json([...ADD, urls.api as string]);
    expect(result.code).toBe(130);
    expect(result.data.error.code).toBe("interrupted");
    expect(existsSync(join(codebase, "api"))).toBe(false);
    expect(files()).toEqual(before);
    expect(existsSync(lockFile)).toBe(false);
    expect(interrupts.listening).toBe(0);
  });

  test("after the config write: everything is undone, exit 130", async () => {
    const before = files();
    fakeFs((fs) => afterCall(fs, "writeText", 1, () => interrupts.fire()));
    const result = await json([...ADD, urls.api as string]);
    expect(result.code).toBe(130);
    expect(result.data.error.code).toBe("interrupted");
    expect(existsSync(join(codebase, "api"))).toBe(false);
    expect(files()).toEqual(before);
  });
});
