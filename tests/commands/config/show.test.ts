import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { main } from "../../../src/cli/index.ts";
import { configShow } from "../../../src/commands/config/show.ts";
import { type Isolation, isolate, writeFile } from "../../helpers/isolate.ts";

let iso: Isolation;
let codebase: string;
let codebaseFile: string;
let userFile: string;

beforeEach(() => {
  iso = isolate();
  codebase = join(iso.root, "shop");
  codebaseFile = join(codebase, ".crossrepo", "config.yaml");
  userFile = join(iso.home, ".crossrepo", "config.yaml");
});

afterEach(() => {
  iso.restore();
});

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

describe("xr config show in a codebase", () => {
  test("--json gives one entries list with absolute sources and resolved", async () => {
    writeFile(userFile, "projects-dir: ~/p\n");
    writeFile(
      codebaseFile,
      [
        "name: shop",
        "project:",
        "  post-create:",
        "    - npm ci",
        "    - cp ../.env .env",
        "  vars:",
        "    PORT: '3000'",
      ].join("\n"),
    );
    const result = await json(["config", "show"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.data).toEqual({
      ok: true,
      warnings: [],
      entries: [
        { key: "name", value: "shop", source: codebaseFile },
        {
          key: "projects-dir",
          value: "~/p",
          source: userFile,
          resolved: join(iso.home, "p"),
        },
        {
          key: "project.post-create",
          value: ["npm ci", "cp ../.env .env"],
          source: codebaseFile,
        },
        { key: "project.vars.PORT", value: "3000", source: codebaseFile },
      ],
    });
  });

  test("the 4 hook lists show with their source, and a later level replaces a whole list", async () => {
    const localFile = join(codebase, ".crossrepo", "config.local.yaml");
    writeFile(
      userFile,
      "project:\n  pre-create: [user-a, user-b]\n  post-remove: [user-c]\n",
    );
    writeFile(
      codebaseFile,
      "project:\n  post-create: [b]\n  pre-remove: [c]\n  post-remove: [d, e]\n",
    );
    writeFile(localFile, "project:\n  pre-create: [local]\n");
    const result = await json(["config", "show"]);
    expect(result.code).toBe(0);
    expect(
      result.data.entries.filter(({ key }: { key: string }) =>
        key.startsWith("project."),
      ),
    ).toEqual([
      { key: "project.pre-create", value: ["local"], source: localFile },
      { key: "project.post-create", value: ["b"], source: codebaseFile },
      { key: "project.pre-remove", value: ["c"], source: codebaseFile },
      { key: "project.post-remove", value: ["d", "e"], source: codebaseFile },
    ]);
    const text = await run(["config", "show"]);
    expect(text.stdout).toContain("project.pre-create ");
    expect(text.stdout).toContain("project.post-remove ");
    expect(text.stdout).toContain("  local\n");
    expect(text.stdout).not.toContain("user-a");
  });

  test("the default projects-dir has the source default", async () => {
    writeFile(codebaseFile, "");
    expect((await json(["config", "show"])).data.entries).toEqual([
      {
        key: "projects-dir",
        value: ".projects",
        source: "default",
        resolved: join(codebase, ".projects"),
      },
    ]);
  });

  test("text mode prints aligned key = value lines with sources relative to the codebase or ~", async () => {
    writeFile(userFile, "projects-dir: ~/p\n");
    writeFile(codebaseFile, "name: shop\nproject:\n  pre-remove: [a, b]\n");
    const result = await run(["config", "show"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const user = join("~", ".crossrepo", "config.yaml");
    const local = join(".crossrepo", "config.yaml");
    expect(result.stdout).toBe(
      [
        `name               = shop  ${local}`,
        `projects-dir       = ~/p   resolved ${join("~", "p")}  ${user}`,
        `project.pre-remove =       ${local}`,
        "  a",
        "  b",
        "",
      ].join("\n"),
    );
  });

  test("--codebase-path picks the codebase from any folder", async () => {
    writeFile(codebaseFile, "name: shop\n");
    const result = await json(
      ["--codebase-path", join("..", "shop"), "config", "show"],
      join(iso.root, "home"),
    );
    expect(result.code).toBe(0);
    expect(result.data.entries[0].value).toBe("shop");
  });
});

describe("xr config show in a project", () => {
  test("uses the codebase of the project record", async () => {
    writeFile(codebaseFile, "name: shop\n");
    const project = join(codebase, ".projects", "feat");
    writeFile(join(project, ".crossrepo", "project.yaml"), "codebase: ../..\n");
    const result = await json(["config", "show"], project);
    expect(result.code).toBe(0);
    expect(result.data.entries[1].resolved).toBe(join(codebase, ".projects"));
  });

  test("a record whose codebase path is missing fails with not-a-codebase", async () => {
    const project = join(iso.root, "feat");
    writeFile(
      join(project, ".crossrepo", "project.yaml"),
      `codebase: ${JSON.stringify(join(iso.root, "gone"))}\n`,
    );
    const result = await json(["config", "show"], project);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("not-a-codebase");
  });
});

describe("xr config show failures", () => {
  test("a folder with no .crossrepo fails with not-a-codebase, nothing on stdout", async () => {
    const result = await run(["config", "show"], iso.root);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(iso.root);
    expect(result.stderr).toContain("--codebase-path <path>");
    const asJson = await json(["config", "show"], iso.root);
    expect(asJson.data.error.code).toBe("not-a-codebase");
    expect(asJson.data.error.hint).toContain("--codebase-path <path>");
  });

  test("a parent codebase is never used", async () => {
    writeFile(codebaseFile, "");
    const child = join(codebase, "api");
    writeFile(join(child, "README.md"), "");
    expect((await json(["config", "show"], child)).data.error.code).toBe(
      "not-a-codebase",
    );
  });

  test("both config.yaml and config.yml fail with config-conflict naming both", async () => {
    writeFile(codebaseFile, "");
    const yml = writeFile(join(codebase, ".crossrepo", "config.yml"), "");
    const result = await json(["config", "show"]);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("config-conflict");
    expect(result.data.error.message).toContain(codebaseFile);
    expect(result.data.error.message).toContain(yml);
    expect((await run(["config", "show"])).stdout).toBe("");
  });

  test("a wrong type fails with invalid-config naming the file and the key", async () => {
    writeFile(codebaseFile, "projects-dir: 3\n");
    const result = await json(["config", "show"]);
    expect(result.code).toBe(1);
    expect(result.data.error.code).toBe("invalid-config");
    expect(result.data.error.message).toContain(codebaseFile);
    expect(result.data.error.message).toContain("projects-dir");
    expect((await run(["config", "show"])).stdout).toBe("");
  });
});

describe("unknown config keys", () => {
  test("warn live on stderr with a did-you-mean hint, and show still runs", async () => {
    writeFile(codebaseFile, "projets-dir: x\n");
    const result = await run(["config", "show"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("projects-dir = .projects");
    expect(result.stderr).toBe(
      `! Unknown config key \`projets-dir\` in ${codebaseFile}.\n  did you mean projects-dir?\n`,
    );
  });

  test("are in warnings with --json, once per key, and also live on stderr", async () => {
    writeFile(userFile, "projets-dir: x\n");
    writeFile(codebaseFile, "projets-dir: y\n");
    const result = await json(["config", "show"]);
    expect(result.data.warnings).toEqual([
      {
        code: "unknown-config-key",
        message: `Unknown config key \`projets-dir\` in ${userFile}, ${codebaseFile}.`,
        hint: "did you mean projects-dir?",
      },
    ]);
    expect(result.stderr.split("\n").filter(Boolean)).toHaveLength(2);
  });
});

describe("--help and --version skip discovery and the config load", () => {
  test("they work with a broken config", async () => {
    writeFile(codebaseFile, "name: [\n");
    expect(await run(["--version"])).toEqual({
      code: 0,
      stdout: "1.2.3\n",
      stderr: "",
    });
    expect((await run(["config", "show", "--version"])).stdout).toBe("1.2.3\n");
    const help = await run(["config", "show", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: xr config show");
    expect((await run(["--help"])).code).toBe(0);
  });
});

test("a relative projects-dir in text mode shows relative to the codebase", async () => {
  writeFile(codebaseFile, "projects-dir: work\n");
  expect((await run(["config", "show"])).stdout).toBe(
    `projects-dir = work  resolved work  ${join(".crossrepo", "config.yaml")}\n`,
  );
});

test("a Report with a reserved key is an internal error with nothing on stdout", async () => {
  writeFile(codebaseFile, "");
  const spy = spyOn(configShow, "run").mockImplementation(async () => ({
    blocks: [{ type: "value", key: "ok", value: "x" }],
  }));
  try {
    const result = await json(["config", "show"]);
    expect(result.code).toBe(1);
    expect(result.data).toMatchObject({
      ok: false,
      error: { code: "internal" },
    });
    const text = await run(["config", "show"]);
    expect(text.stdout).toBe("");
    expect(text.stderr).toContain("reserved");
  } finally {
    spy.mockRestore();
  }
});
