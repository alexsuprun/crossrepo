import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import {
  git,
  makeRepos,
  pushCommit,
  removeRepoTemplates,
  repoTemplateRoot,
} from "../helpers/git.ts";
import { type Isolation, isolate } from "../helpers/isolate.ts";

let iso: Isolation;

beforeEach(() => {
  iso = isolate();
});

afterEach(() => {
  iso.restore();
});

describe("makeRepos", () => {
  test("a second call with the same repo kinds starts no git process", () => {
    const spec = {
      api: {},
      solo: { origin: false },
      dev: { branch: "develop", head: false },
    };
    makeRepos(join(iso.root, "first"), spec);
    const path = process.env.PATH;
    // No git on PATH: any git start now fails.
    process.env.PATH = join(iso.root, "no-git");
    try {
      makeRepos(join(iso.root, "second"), spec);
    } finally {
      process.env.PATH = path;
    }
    const api = join(iso.root, "second", "api");
    expect(git(api, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
    expect(git(api, "rev-parse", "--abbrev-ref", "origin/HEAD").trim()).toBe(
      "origin/main",
    );
    const dev = join(iso.root, "second", "dev");
    expect(git(dev, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(
      "develop",
    );
    expect(() => git(dev, "rev-parse", "--verify", "origin/HEAD")).toThrow();
    expect(git(join(iso.root, "second", "solo"), "remote").trim()).toBe("");
  });

  test("each call gives repos with their own origin", () => {
    const first = makeRepos(join(iso.root, "first"), { api: {} });
    const second = makeRepos(join(iso.root, "second"), { api: {} });
    const origin = (root: string) =>
      git(join(iso.root, root, "api"), "remote", "get-url", "origin").trim();
    expect(origin("first")).toBe(first.api as string);
    expect(origin("second")).toBe(second.api as string);

    const pushed = pushCommit(first.api as string, { file: "a.txt" });
    git(join(iso.root, "first", "api"), "fetch", "--quiet", "origin");
    git(join(iso.root, "second", "api"), "fetch", "--quiet", "origin");
    expect(
      git(join(iso.root, "first", "api"), "rev-parse", "origin/main").trim(),
    ).toBe(pushed);
    expect(
      git(join(iso.root, "second", "api"), "rev-parse", "origin/main").trim(),
    ).not.toBe(pushed);
  });

  test("removeRepoTemplates deletes the templates, and the next call makes them again", () => {
    makeRepos(join(iso.root, "first"), { api: {} });
    const templates = repoTemplateRoot() as string;
    expect(existsSync(templates)).toBe(true);
    removeRepoTemplates();
    expect(existsSync(templates)).toBe(false);
    expect(repoTemplateRoot()).toBeUndefined();
    makeRepos(join(iso.root, "second"), { api: {} });
    expect(
      git(join(iso.root, "second", "api"), "rev-parse", "HEAD").trim(),
    ).toMatch(/^[0-9a-f]{40}$/);
  });

  test.skipIf(process.platform === "win32")(
    "a template build starts no background git: no push, and no auto maintenance after the commit",
    () => {
      const real = spawnSync("sh", ["-c", "command -v git"], {
        encoding: "utf8",
      }).stdout.trim();
      const bin = join(iso.root, "bin");
      mkdirSync(bin);
      const log = join(iso.root, "git-calls.log");
      writeFileSync(
        join(bin, "git"),
        `#!/bin/sh\necho "$*" >> "${log}"\nexec "${real}" "$@"\n`,
      );
      chmodSync(join(bin, "git"), 0o755);
      const path = process.env.PATH;
      process.env.PATH = `${bin}${delimiter}${path}`;
      let remotes: Record<string, string | undefined>;
      try {
        remotes = makeRepos(join(iso.root, "shop"), {
          api: { branch: "no-background" },
        });
      } finally {
        process.env.PATH = path;
      }
      const calls = readFileSync(log, "utf8").trim().split("\n");
      expect(calls.filter((call) => / push /.test(` ${call} `))).toEqual([]);
      const commits = calls.filter((call) => / commit /.test(` ${call} `));
      expect(commits).toHaveLength(1);
      expect(commits[0]).toContain("-c maintenance.auto=false");
      expect(commits[0]).toContain("-c gc.auto=0");

      const origin = remotes.api as string;
      const api = join(iso.root, "shop", "api");
      const headOf = (dir: string, ref: string) =>
        git(dir, "rev-parse", ref).trim();
      expect(git(origin, "rev-parse", "--is-bare-repository").trim()).toBe(
        "true",
      );
      expect(headOf(origin, "refs/heads/no-background")).toBe(
        headOf(api, "HEAD"),
      );
      expect(headOf(api, "origin/no-background")).toBe(headOf(api, "HEAD"));
      expect(git(api, "rev-parse", "--abbrev-ref", "origin/HEAD").trim()).toBe(
        "origin/no-background",
      );
    },
  );
});

for (const file of ["bunfig.toml", "bunfig.smoke.toml"]) {
  test(`${file} preloads the file that removes the repo templates after all tests`, async () => {
    const bunfig = Bun.TOML.parse(
      await Bun.file(new URL(`../../${file}`, import.meta.url)).text(),
    ) as { test?: { preload?: string[] } };
    expect(bunfig.test?.preload).toContain("./tests/helpers/preload.ts");
  });
}

test("the preload removes the repo templates after all tests", async () => {
  const preload = await Bun.file(
    new URL("../helpers/preload.ts", import.meta.url),
  ).text();
  expect(preload).toContain("afterAll(removeRepoTemplates)");
});
