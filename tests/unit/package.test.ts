import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";

const pkg = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);

describe("package.json publish contract", () => {
  test("name is crossrepo", () => {
    expect(pkg.name).toBe("crossrepo");
  });

  test("license is MIT", () => {
    expect(pkg.license).toBe("MIT");
  });

  test("type is module", () => {
    expect(pkg.type).toBe("module");
  });

  test("engines.node is >=22.13", () => {
    expect(pkg.engines?.node).toBe(">=22.13");
  });

  test("bin.crossrepo points at dist/xr.js", () => {
    expect(pkg.bin?.crossrepo).toBe("dist/xr.js");
  });

  test("bin.xr points at dist/xr.js", () => {
    expect(pkg.bin?.xr).toBe("dist/xr.js");
  });

  test("files ships only dist", () => {
    expect(pkg.files).toEqual(["dist"]);
  });

  // npm provenance fails when this url does not match the GitHub repo exactly.
  test("repository.url is the exact GitHub repo", () => {
    expect(pkg.repository?.url).toBe(
      "git+https://github.com/alexsuprun/crossrepo.git",
    );
  });

  test("homepage is the docs site", () => {
    expect(pkg.homepage).toBe("https://alexsuprun.github.io/crossrepo/");
  });

  test("bugs.url is the GitHub issues page", () => {
    expect(pkg.bugs?.url).toBe(
      "https://github.com/alexsuprun/crossrepo/issues",
    );
  });

  // A publish must rebuild dist/ so a stale bundle or version never ships.
  test("scripts.prepublishOnly builds the bundle", () => {
    expect(pkg.scripts?.prepublishOnly).toBe("bun run build");
  });

  test("scripts.release is changeset publish", () => {
    expect(pkg.scripts?.release).toBe("changeset publish");
  });

  test("scripts.test runs the test files in parallel with the coverage floor", () => {
    expect(pkg.scripts?.test).toBe(
      "bun test --coverage --parallel --timeout 30000",
    );
  });

  test("scripts.test:no-coverage is scripts.test without coverage", () => {
    expect(pkg.scripts?.["test:no-coverage"]).toBe(
      pkg.scripts?.test.replace("--coverage ", ""),
    );
  });

  test("description is not empty", () => {
    expect(typeof pkg.description).toBe("string");
    expect(pkg.description.trim()).not.toBe("");
  });

  test("keywords equal the GitHub repo topics", () => {
    expect(pkg.keywords).toEqual([
      "ai-agents",
      "bun",
      "cli",
      "developer-tools",
      "git",
      "git-worktree",
      "multi-repo",
      "typescript",
      "worktree",
    ]);
  });

  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "bundleDependencies",
  ]) {
    test(`${field} is empty or absent`, () => {
      const value = pkg[field];
      if (value === undefined) return;
      const size = Array.isArray(value)
        ? value.length
        : Object.keys(value).length;
      expect(size).toBe(0);
    });
  }
});

// These files break publishing only on master, so PR checks must catch drift.
describe(".changeset/config.json", () => {
  const config = JSON.parse(
    readFileSync(
      new URL("../../.changeset/config.json", import.meta.url),
      "utf8",
    ),
  );

  test("baseBranch is master", () => {
    expect(config.baseBranch).toBe("master");
  });

  test("access is public", () => {
    expect(config.access).toBe("public");
  });

  test("the changelog module is a devDependency", () => {
    expect(pkg.devDependencies?.[config.changelog[0]]).toBeDefined();
  });

  test("changelog uses changelog-github for alexsuprun/crossrepo", () => {
    expect(config.changelog).toEqual([
      "@changesets/changelog-github",
      { repo: "alexsuprun/crossrepo" },
    ]);
  });
});

// Coverage is the same on every OS, so only the fast Linux runner pays for it.
describe(".github/workflows/ci.yml", () => {
  const workflow = parse(
    readFileSync(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    ),
  );
  const steps: { run?: string; if?: string }[] =
    workflow.jobs?.checks?.steps ?? [];

  test("jobs.checks runs the coverage floor on Linux and the tests without coverage elsewhere", () => {
    expect(
      steps
        .filter((step) => step.run?.startsWith("bun run test"))
        .map((step) => ({ run: step.run, if: step.if })),
    ).toEqual([
      { run: "bun run test", if: "runner.os == 'Linux'" },
      { run: "bun run test:no-coverage", if: "runner.os != 'Linux'" },
    ]);
  });
});

// The npm Trusted Publisher fixes the file name release.yml and environment npm.
describe(".github/workflows/release.yml", () => {
  const url = new URL("../../.github/workflows/release.yml", import.meta.url);

  test("the file exists", () => {
    expect(existsSync(url)).toBe(true);
  });

  const workflow = existsSync(url) ? parse(readFileSync(url, "utf8")) : {};
  const jobs: Record<string, { environment?: unknown; permissions?: unknown }> =
    workflow.jobs ?? {};

  test("jobs.release uses environment npm", () => {
    expect(jobs.release?.environment).toBe("npm");
  });

  // Tests and dev tools run in "check", away from the job that can mint the OIDC token.
  test("jobs.release needs jobs.check", () => {
    expect(jobs.check).toBeDefined();
    expect((jobs.release as { needs?: unknown } | undefined)?.needs).toBe(
      "check",
    );
  });

  test("top-level permissions are contents: read", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  test("id-token: write is set only on jobs.release", () => {
    const withIdToken = Object.entries(jobs)
      .filter(
        ([, job]) =>
          (job.permissions as Record<string, string> | undefined)?.[
            "id-token"
          ] === "write",
      )
      .map(([name]) => name);
    expect(withIdToken).toEqual(["release"]);
  });
});
