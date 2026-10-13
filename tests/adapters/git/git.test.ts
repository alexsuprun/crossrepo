import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createGit, parseVersion } from "../../../src/adapters/git/index.ts";
import { GitError, XrError } from "../../../src/errors/index.ts";
import { git, makeRepos } from "../../helpers/git.ts";
import { type Isolation, isolate, writeFile } from "../../helpers/isolate.ts";

let iso: Isolation;
let root: string;

beforeEach(() => {
  iso = isolate();
  root = join(iso.root, "shop");
  mkdirSync(root);
});

afterEach(() => {
  iso.restore();
});

const env = () => ({ ...process.env });

describe("createGit with real repos", () => {
  test("version gives the installed version", async () => {
    expect(
      await createGit({ interactive: false, env: env() }).version(),
    ).toMatch(/^\d+\.\d+/);
  });

  test("originUrl gives the origin URL as written, without insteadOf", async () => {
    const remotes = makeRepos(root, { api: {}, solo: { origin: false } });
    git(
      join(root, "api"),
      "config",
      "url.https://example.com/.insteadOf",
      remotes.api as string,
    );
    const adapter = createGit({ interactive: false, env: env() });
    expect(await adapter.originUrl(join(root, "api"))).toBe(
      remotes.api as string,
    );
    expect(await adapter.originUrl(join(root, "solo"))).toBeUndefined();
  });

  test("originUrl gives undefined for an empty origin URL", async () => {
    makeRepos(root, { api: { origin: false } });
    git(join(root, "api"), "config", "remote.origin.url", "");
    const adapter = createGit({ interactive: false, env: env() });
    expect(await adapter.originUrl(join(root, "api"))).toBeUndefined();
  });

  test("originHead gives the default branch without origin/, or undefined", async () => {
    makeRepos(root, {
      api: { branch: "trunk" },
      web: { head: false },
      solo: { origin: false },
    });
    const adapter = createGit({ interactive: false, env: env() });
    expect(await adapter.originHead(join(root, "api"))).toBe("trunk");
    expect(await adapter.originHead(join(root, "web"))).toBeUndefined();
    expect(await adapter.originHead(join(root, "solo"))).toBeUndefined();
  });

  test("a folder that is not a repo fails with a GitError", async () => {
    const dir = join(iso.root, "plain");
    mkdirSync(dir);
    const error = await createGit({ interactive: false, env: env() })
      .originHead(dir)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GitError);
    expect(error).toMatchObject({
      code: "git-failed",
      exitCode: 128,
      args: [
        "-C",
        dir,
        "symbolic-ref",
        "--quiet",
        "--short",
        "refs/remotes/origin/HEAD",
      ],
    });
    expect((error as GitError).stderr).toContain("not a git repository");
  });

  test("git missing from PATH is a GitError", async () => {
    const empty = join(iso.root, "empty");
    mkdirSync(empty);
    const error = await createGit({
      interactive: false,
      env: { ...env(), PATH: empty, Path: empty },
    })
      .version()
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).message).toContain("not found");
  });
});

/** A fake `git` that logs each call and prints its env for any command but `version`. */
function fakeGit(version: string): { env: NodeJS.ProcessEnv; log: string } {
  const bin = join(iso.root, "fake-bin");
  const log = join(iso.root, "fake-git.log");
  const script = writeFile(
    join(bin, "git"),
    [
      "#!/bin/sh",
      `echo "$*" >> "${log}"`,
      `if [ "$1" = version ]; then echo "git version ${version}"; exit 0; fi`,
      'printf "%s|" "LC_ALL=$LC_ALL" "GIT_TERMINAL_PROMPT=$GIT_TERMINAL_PROMPT" "GCM_INTERACTIVE=$GCM_INTERACTIVE" "GIT_SSH_COMMAND=$GIT_SSH_COMMAND"',
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  return {
    env: { ...env(), PATH: [bin, process.env.PATH].join(delimiter) },
    log,
  };
}

describe("parseVersion", () => {
  test("gives the version from `git version`, with any suffix", () => {
    expect(parseVersion("git version 2.27.0\n")).toBe("2.27.0");
    expect(parseVersion("git version 2.45.1.windows.1\n")).toBe(
      "2.45.1.windows.1",
    );
    expect(parseVersion("git version 3.0.0")).toBe("3.0.0");
  });

  test("below 2.27 is git-too-old with the found version and an upgrade hint", () => {
    for (const out of ["git version 2.26.9", "git version 1.99.0"]) {
      let thrown: unknown;
      try {
        parseVersion(out);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(XrError);
      expect(thrown).toMatchObject({ code: "git-too-old" });
      expect((thrown as XrError).message).toContain(out.slice(12));
      expect((thrown as XrError).hint).toContain("Upgrade git");
    }
  });

  test("text that is not a git version is git-failed", () => {
    expect(() => parseVersion("hello")).toThrow(GitError);
  });
});

describe.skipIf(process.platform === "win32")(
  "createGit with a fake git",
  () => {
    test("git older than 2.27 fails with git-too-old, the found version and an upgrade hint", async () => {
      const fake = fakeGit("2.26.9");
      const error = await createGit({ interactive: false, env: fake.env })
        .originUrl(root)
        .catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(XrError);
      expect(error).toMatchObject({ code: "git-too-old" });
      expect((error as XrError).message).toContain("2.26.9");
      expect((error as XrError).hint).toContain("2.27");
    });

    test("checks the version once, at the first call", async () => {
      const fake = fakeGit("2.27.0.windows.1");
      const adapter = createGit({ interactive: false, env: fake.env });
      expect(await adapter.version()).toBe("2.27.0.windows.1");
      await adapter.originUrl(root);
      await adapter.originHead(root);
      const calls = readFileSync(fake.log, "utf8").trim().split("\n");
      expect(calls.filter((call) => call === "version")).toHaveLength(1);
      expect(calls).toHaveLength(3);
    });

    test("an unreadable version fails with git-failed", async () => {
      const fake = fakeGit("unknown");
      const error = await createGit({ interactive: false, env: fake.env })
        .version()
        .catch((thrown: unknown) => thrown);
      expect(error).toMatchObject({ code: "git-failed" });
    });

    test("not interactive: LC_ALL=C, no prompts and ssh BatchMode", async () => {
      const fake = fakeGit("2.40.0");
      const out = await createGit({
        interactive: false,
        env: { ...fake.env, GIT_SSH_COMMAND: undefined, LC_ALL: "de_DE" },
      }).originUrl(root);
      expect(out).toBe(
        "LC_ALL=C|GIT_TERMINAL_PROMPT=0|GCM_INTERACTIVE=never|GIT_SSH_COMMAND=ssh -o BatchMode=yes|",
      );
    });

    test("a GIT_SSH_COMMAND set by the user is kept", async () => {
      const fake = fakeGit("2.40.0");
      const out = await createGit({
        interactive: false,
        env: { ...fake.env, GIT_SSH_COMMAND: "ssh -i key" },
      }).originUrl(root);
      expect(out).toContain("GIT_SSH_COMMAND=ssh -i key|");
    });

    test("GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE from the caller env are dropped", async () => {
      const fake = fakeGit("2.40.0");
      const bin = join(iso.root, "fake-bin");
      writeFile(
        join(bin, "git"),
        [
          "#!/bin/sh",
          'if [ "$1" = version ]; then echo "git version 2.40.0"; exit 0; fi',
          'printf "%s|" "GIT_DIR=$GIT_DIR" "GIT_WORK_TREE=$GIT_WORK_TREE" "GIT_INDEX_FILE=$GIT_INDEX_FILE"',
          "",
        ].join("\n"),
      );
      const out = await createGit({
        interactive: false,
        env: {
          ...fake.env,
          GIT_DIR: "/x/.git",
          GIT_WORK_TREE: "/x",
          GIT_INDEX_FILE: "/x/index",
        },
      }).originUrl(root);
      expect(out).toBe("GIT_DIR=|GIT_WORK_TREE=|GIT_INDEX_FILE=|");
    });

    test("an aborted signal stops git: GitError with exitCode null", async () => {
      const bin = join(iso.root, "slow-bin");
      const script = writeFile(
        join(bin, "git"),
        [
          "#!/bin/sh",
          'if [ "$1" = version ]; then echo "git version 2.40.0"; exit 0; fi',
          "exec sleep 10",
          "",
        ].join("\n"),
      );
      chmodSync(script, 0o755);
      const adapter = createGit({
        interactive: false,
        env: { ...env(), PATH: [bin, process.env.PATH].join(delimiter) },
      });
      const controller = new AbortController();
      const started = Date.now();
      const call = adapter
        .originUrl(root, { signal: controller.signal })
        .catch((thrown: unknown) => thrown);
      setTimeout(() => controller.abort(), 200);
      const error = await call;
      expect(Date.now() - started).toBeLessThan(5000);
      expect(error).toBeInstanceOf(GitError);
      expect(error).toMatchObject({ code: "git-failed", exitCode: null });
      const head = await adapter
        .originHead(root, { signal: AbortSignal.abort() })
        .catch((thrown: unknown) => thrown);
      expect(head).toMatchObject({ exitCode: null });
    });

    test("interactive: only LC_ALL=C is set", async () => {
      const fake = fakeGit("2.40.0");
      const out = await createGit({
        interactive: true,
        env: {
          ...fake.env,
          GIT_SSH_COMMAND: undefined,
          GIT_TERMINAL_PROMPT: undefined,
          GCM_INTERACTIVE: undefined,
        },
      }).originUrl(root);
      expect(out).toBe(
        "LC_ALL=C|GIT_TERMINAL_PROMPT=|GCM_INTERACTIVE=|GIT_SSH_COMMAND=|",
      );
    });
  },
);
