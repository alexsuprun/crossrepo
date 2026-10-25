import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  ConfigError,
  type LoadedConfig,
  loadConfig,
} from "../../../src/config/index.ts";
import { type Isolation, isolate, writeFile } from "../../helpers/isolate.ts";

let iso: Isolation;
let codebase: string;
let userFile: string;
let codebaseFile: string;
let localFile: string;

beforeEach(() => {
  iso = isolate();
  codebase = join(iso.root, "shop");
  mkdirSync(join(codebase, ".crossrepo"), { recursive: true });
  userFile = join(iso.home, ".crossrepo", "config.yaml");
  codebaseFile = join(codebase, ".crossrepo", "config.yaml");
  localFile = join(codebase, ".crossrepo", "config.local.yaml");
});

afterEach(() => {
  iso.restore();
});

function load(): LoadedConfig {
  return loadConfig({ home: iso.home, codebase });
}

function loadError(): ConfigError {
  try {
    load();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("loadConfig did not throw");
}

function entry(config: LoadedConfig, key: string) {
  return config.entries.find((item) => item.key === key);
}

describe("loadConfig levels", () => {
  test("a later level wins, maps merge key by key and lists are replaced whole", () => {
    writeFile(
      userFile,
      [
        "name: from-user",
        "project:",
        "  post-create: [user-a, user-b]",
        "  vars:",
        "    A: user",
        "    B: user",
      ].join("\n"),
    );
    writeFile(
      codebaseFile,
      [
        "name: shop",
        "repos:",
        "  api:",
        "    remote: git@h:api.git",
        "    default-branch: main",
        "project:",
        "  vars:",
        "    B: codebase",
      ].join("\n"),
    );
    writeFile(
      localFile,
      [
        "repos:",
        "  api:",
        "    remote: https://h/api.git",
        "project:",
        "  post-create:",
        "    - local",
      ].join("\n"),
    );
    const config = load();
    expect(config.values).toEqual({
      name: "shop",
      repos: { api: { remote: "https://h/api.git", "default-branch": "main" } },
      project: {
        "post-create": ["local"],
        vars: { A: "user", B: "codebase" },
      },
    });
    expect(
      config.entries.map(({ key, value, source }) => ({
        key,
        value,
        source: source.kind === "file" ? source.path : "default",
      })),
    ).toEqual([
      { key: "name", value: "shop", source: codebaseFile },
      { key: "projects-dir", value: ".projects", source: "default" },
      {
        key: "repos.api.remote",
        value: "https://h/api.git",
        source: localFile,
      },
      { key: "repos.api.default-branch", value: "main", source: codebaseFile },
      { key: "project.post-create", value: ["local"], source: localFile },
      { key: "project.vars.A", value: "user", source: userFile },
      { key: "project.vars.B", value: "codebase", source: codebaseFile },
    ]);
    expect(config.unknownKeys).toEqual([]);
  });

  test("missing files are skipped, and an empty file sets nothing", () => {
    writeFile(codebaseFile, "");
    const config = load();
    expect(config.values).toEqual({});
    expect(config.entries.map((item) => item.key)).toEqual(["projects-dir"]);
  });

  test("each level accepts .yml", () => {
    writeFile(join(iso.home, ".crossrepo", "config.yml"), "name: u\n");
    writeFile(join(codebase, ".crossrepo", "config.local.yml"), "name: l\n");
    expect(entry(load(), "name")).toEqual({
      key: "name",
      value: "l",
      source: {
        kind: "file",
        path: join(codebase, ".crossrepo", "config.local.yml"),
      },
    });
  });

  test("a symlinked config file is followed, and the source is the link", () => {
    const real = writeFile(join(codebase, "meta", "crossrepo.yaml"), "name: x");
    symlinkSync(real, codebaseFile);
    expect(entry(load(), "name")?.source).toEqual({
      kind: "file",
      path: codebaseFile,
    });
  });

  test("a key set to nothing counts as not set", () => {
    writeFile(userFile, "name: u\n");
    writeFile(
      codebaseFile,
      "name:\nprojects-dir:\nproject:\n  post-create:\nrepos:\n  api:\n",
    );
    const config = load();
    expect(config.values).toEqual({ name: "u", repos: {}, project: {} });
    expect(entry(config, "projects-dir")?.source).toEqual({ kind: "default" });
  });

  test("project.vars numbers and booleans become text", () => {
    writeFile(
      codebaseFile,
      "project:\n  vars:\n    PORT: 5432\n    DEBUG: true\n    RATE: 1.5\n",
    );
    const config = load();
    expect(config.values.project?.vars).toEqual({
      PORT: "5432",
      DEBUG: "true",
      RATE: "1.5",
    });
    expect(entry(config, "project.vars.PORT")?.value).toBe("5432");
  });

  for (const [what, value] of [
    ["a list", "[a, b]"],
    ["a map", "{a: 1}"],
  ] as const) {
    test(`a project.vars value that is ${what} is invalid`, () => {
      writeFile(codebaseFile, `project:\n  vars:\n    X: ${value}\n`);
      const error = loadError();
      expect(error.kind).toBe("invalid");
      expect(error.message).toContain("project.vars.X");
    });
  }

  test("a CROSSREPO_ name in project.vars does not fail the load", () => {
    writeFile(codebaseFile, "project:\n  vars:\n    CROSSREPO_X: y\n");
    expect(entry(load(), "project.vars.CROSSREPO_X")?.value).toBe("y");
  });
});

describe("with no codebase", () => {
  test("reads only the user level and keeps a relative projects-dir as written", () => {
    writeFile(userFile, "name: me\nprojects-dir: work\n");
    writeFile(codebaseFile, "name: [\n");
    writeFile(localFile, "name: [\n");
    const config = loadConfig({ home: iso.home });
    expect(config.codebase).toBeUndefined();
    expect(entry(config, "name")?.value).toBe("me");
    expect(config.projectsDir.resolved).toBe("work");
  });
});

describe("projects-dir", () => {
  test("is .projects with the source default when no level sets it", () => {
    const config = load();
    expect(config.projectsDir).toEqual({
      value: ".projects",
      source: { kind: "default" },
      resolved: join(codebase, ".projects"),
    });
    expect(entry(config, "projects-dir")?.resolved).toBe(
      join(codebase, ".projects"),
    );
  });

  test("a relative path is relative to the codebase at every level", () => {
    writeFile(userFile, "projects-dir: ../work\n");
    expect(load().projectsDir).toEqual({
      value: "../work",
      source: { kind: "file", path: userFile },
      resolved: join(iso.root, "work"),
    });
  });

  test("a leading ~ is the home folder", () => {
    writeFile(codebaseFile, "projects-dir: ~/p\n");
    expect(load().projectsDir.resolved).toBe(join(iso.home, "p"));
    writeFile(codebaseFile, "projects-dir: '~'\n");
    expect(load().projectsDir.resolved).toBe(iso.home);
  });

  test("an absolute path stays as it is, and nothing else is expanded", () => {
    const absolute = join(iso.root, "abs");
    writeFile(codebaseFile, `projects-dir: ${JSON.stringify(absolute)}\n`);
    expect(load().projectsDir.resolved).toBe(absolute);
    writeFile(codebaseFile, "projects-dir: $HOME/x\n");
    expect(load().projectsDir.resolved).toBe(join(codebase, "$HOME", "x"));
    writeFile(codebaseFile, "projects-dir: ~x\n");
    expect(load().projectsDir.resolved).toBe(join(codebase, "~x"));
  });
});

describe("unknown keys", () => {
  test("are collected once per key with a did-you-mean hint, and the load still works", () => {
    writeFile(userFile, "projets-dir: x\n");
    writeFile(
      codebaseFile,
      [
        "projets-dir: y",
        "name: shop",
        "project:",
        "  post_create: [a]",
        "repos:",
        "  api:",
        "    remot: r",
      ].join("\n"),
    );
    const config = load();
    expect(config.unknownKeys).toEqual([
      {
        key: "projets-dir",
        files: [userFile, codebaseFile],
        suggestion: "projects-dir",
      },
      {
        key: "repos.api.remot",
        files: [codebaseFile],
        suggestion: "repos.api.remote",
      },
      {
        key: "project.post_create",
        files: [codebaseFile],
        suggestion: "project.post-create",
      },
    ]);
    expect(config.values).toEqual({
      name: "shop",
      repos: { api: {} },
      project: {},
    });
  });
});

describe("config errors", () => {
  test("both .yaml and .yml at one level is a conflict naming both files", () => {
    writeFile(codebaseFile, "name: a\n");
    const yml = writeFile(join(codebase, ".crossrepo", "config.yml"), "");
    const error = loadError();
    expect(error.kind).toBe("conflict");
    expect(error.message).toContain(codebaseFile);
    expect(error.message).toContain(yml);
    expect(error.hint).toBeDefined();
  });

  test("a value of the wrong type is invalid, naming the file and the key", () => {
    writeFile(localFile, "projects-dir: 3\n");
    const error = loadError();
    expect(error.kind).toBe("invalid");
    expect(error.message).toContain(localFile);
    expect(error.message).toContain("projects-dir");
    expect(error.message).toContain("expected string, received number");
  });

  test("an empty projects-dir is invalid, naming the file and the key", () => {
    writeFile(codebaseFile, "projects-dir: ''\n");
    const error = loadError();
    expect(error.kind).toBe("invalid");
    expect(error.message).toContain(codebaseFile);
    expect(error.message).toContain("projects-dir");
  });

  test("a nested wrong type names the dotted key", () => {
    writeFile(userFile, "project:\n  post-create: [1]\n");
    expect(loadError().message).toContain("project.post-create.0");
  });

  test("a file that is not a map is invalid", () => {
    writeFile(userFile, "- a\n");
    const error = loadError();
    expect(error.kind).toBe("invalid");
    expect(error.message).toContain(userFile);
  });

  test("bad YAML is invalid, naming the file", () => {
    writeFile(codebaseFile, "name: [a\n");
    const error = loadError();
    expect(error.kind).toBe("invalid");
    expect(error.message).toContain(codebaseFile);
  });

  test("a duplicate key is invalid", () => {
    writeFile(codebaseFile, "name: a\nname: b\n");
    expect(loadError().kind).toBe("invalid");
  });
});
