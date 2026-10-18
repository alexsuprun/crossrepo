import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Command } from "commander";
import {
  configView,
  main,
  readGlobalFlags,
  toXrError,
} from "../../src/cli/index.ts";
import { ConfigError } from "../../src/config/index.ts";
import { XrError } from "../../src/errors/index.ts";

interface RunOptions {
  env?: Record<string, string | undefined>;
  isTTY?: { stdin: boolean; stdout: boolean; stderr: boolean };
}

async function run(argv: string[], options: RunOptions = {}) {
  let stdout = "";
  let stderr = "";
  const code = await main({
    version: "1.2.3",
    argv,
    env: options.env ?? {},
    isTTY: options.isTTY ?? { stdin: false, stdout: false, stderr: false },
    cwd: "/nowhere",
    home: "/home/me",
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

const USAGE_HINT = "Run `xr --help` for usage.";
const BUG_HINT =
  "This is a bug in xr. Run it again with `--verbose` and report the output at https://github.com/alexsuprun/crossrepo/issues.";

describe("main", () => {
  test("is async, so a command can wait for git", async () => {
    const pending = main({
      version: "1.2.3",
      argv: ["--version"],
      env: {},
      isTTY: { stdin: false, stdout: false, stderr: false },
      cwd: "/nowhere",
      home: "/home/me",
      stdout: () => {},
      stderr: () => {},
    });
    expect(pending).toBeInstanceOf(Promise);
    expect(await pending).toBe(0);
  });

  test("--version prints only the version on stdout and exits 0", async () => {
    expect(await run(["--version"])).toEqual({
      code: 0,
      stdout: "1.2.3\n",
      stderr: "",
    });
  });

  test("--version wins over a usage error or --help, as commander .version() did", async () => {
    for (const argv of [
      ["--version", "--nope"],
      ["--nope", "--version"],
      ["--version", "extra"],
      ["--version", "--codebase-path"],
      ["--version", "--help"],
      ["--help", "--version"],
    ]) {
      expect(await run(argv)).toEqual({
        code: 0,
        stdout: "1.2.3\n",
        stderr: "",
      });
    }
  });

  test("--help prints usage with the 4 global flags on stdout and exits 0", async () => {
    const result = await run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: xr");
    expect(result.stdout).toContain("--codebase-path <path>");
    expect(result.stdout).toContain("--json");
    expect(result.stdout).toContain("--no-interactive");
    expect(result.stdout).toContain("--verbose");
  });

  test("no arguments prints usage on stdout and exits 0", async () => {
    const result = await run([]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: xr");
  });

  test("the 4 global flags are accepted", async () => {
    const result = await run([
      "--codebase-path",
      "/tmp/x",
      "--no-interactive",
      "--verbose",
    ]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("--help lists the config command", async () => {
    expect((await run(["--help"])).stdout).toContain("config");
  });

  test("config with no subcommand prints its help and exits 0", async () => {
    const result = await run(["config"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: xr config");
    expect(result.stdout).toContain("show");
  });

  test("codebase help lists the repo group", async () => {
    const result = await run(["codebase", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^ {2}repo\b/m);
  });

  test("codebase repo with no subcommand prints its help with list and exits 0", async () => {
    for (const argv of [
      ["codebase", "repo"],
      ["codebase", "repo", "--help"],
    ]) {
      const result = await run(argv);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Usage: xr codebase repo");
      expect(result.stdout).toContain("list");
    }
  });

  test("codebase repo list --help prints its own usage", async () => {
    const result = await run(["codebase", "repo", "list", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: xr codebase repo list");
  });

  test("an unknown subcommand or argument is a usage error", async () => {
    for (const argv of [
      ["config", "nope"],
      ["config", "show", "x"],
      ["codebase", "repo", "nope"],
      ["codebase", "repo", "list", "x"],
    ]) {
      const result = await run(argv);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(USAGE_HINT);
    }
  });

  test("unknown option prints an error on stderr only and exits 2", async () => {
    const result = await run(["--nope"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      `error: unknown option '--nope'\n${USAGE_HINT}\n`,
    );
  });

  test("an unexpected argument is a usage error with exit 2", async () => {
    const result = await run(["extra"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(USAGE_HINT);
  });

  test("--verbose prints no stack trace for a usage error", async () => {
    expect(await run(["--verbose", "--nope"])).toEqual({
      code: 2,
      stdout: "",
      stderr: `error: unknown option '--nope'\n${USAGE_HINT}\n`,
    });
  });

  test("a missing option value is a usage error with exit 2", async () => {
    const result = await run(["--codebase-path"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(USAGE_HINT);
  });

  test("a TTY stderr gets the error in rich mode", async () => {
    const result = await run(["--nope"], {
      isTTY: { stdin: true, stdout: false, stderr: true },
    });
    expect(result.stderr).toContain("\u001b[");
    expect(result.stdout).toBe("");
  });

  test("NO_COLOR keeps a TTY stderr plain", async () => {
    const result = await run(["--nope"], {
      env: { NO_COLOR: "1" },
      isTTY: { stdin: true, stdout: true, stderr: true },
    });
    expect(result.stderr).toBe(
      `error: unknown option '--nope'\n${USAGE_HINT}\n`,
    );
  });
});

describe("main with --json", () => {
  test("--version prints one JSON object with the version", async () => {
    for (const argv of [
      ["--json", "--version"],
      ["--version", "--json"],
    ]) {
      expect(await run(argv)).toEqual({
        code: 0,
        stdout: '{"ok":true,"warnings":[],"version":"1.2.3"}\n',
        stderr: "",
      });
    }
  });

  test("--version wins over a later usage error and still prints JSON", async () => {
    expect(await run(["--version", "--json", "--nope"])).toEqual({
      code: 0,
      stdout: '{"ok":true,"warnings":[],"version":"1.2.3"}\n',
      stderr: "",
    });
  });

  test("--help prints one JSON object with the help text", async () => {
    for (const argv of [
      ["--json", "--help"],
      ["--help", "--json"],
      ["--json"],
    ]) {
      const result = await run(argv);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      const envelope = JSON.parse(result.stdout);
      expect(Object.keys(envelope)).toEqual(["ok", "warnings", "help"]);
      expect(envelope.ok).toBe(true);
      expect(envelope.warnings).toEqual([]);
      expect(envelope.help).toContain("Usage: xr");
      expect(envelope.help).toBe((await run(["--help"])).stdout);
    }
  });

  test("a usage error is one JSON object on stdout and exits 2", async () => {
    for (const argv of [
      ["--json", "--nope"],
      ["--nope", "--json"],
      ["--json", "extra"],
      ["--json", "--codebase-path"],
    ]) {
      const result = await run(argv);
      expect(result.code).toBe(2);
      expect(result.stderr).toBe("");
      const envelope = JSON.parse(result.stdout);
      expect(envelope).toMatchObject({
        ok: false,
        warnings: [],
        error: { code: "usage", hint: USAGE_HINT },
      });
      expect(Object.keys(envelope.error)).toEqual(["code", "message", "hint"]);
    }
  });

  test("stdout is JSON even when stdout is a TTY with FORCE_COLOR", async () => {
    const result = await run(["--json", "--version"], {
      env: { FORCE_COLOR: "1" },
      isTTY: { stdin: true, stdout: true, stderr: true },
    });
    expect(result.stdout).toBe('{"ok":true,"warnings":[],"version":"1.2.3"}\n');
  });
});

describe("main on a crash", () => {
  let helpInformation: ReturnType<typeof spyOn> | undefined;

  afterEach(() => {
    helpInformation?.mockRestore();
  });

  function crash() {
    const error = new Error("boom");
    helpInformation = spyOn(
      Command.prototype,
      "helpInformation",
    ).mockImplementation(() => {
      throw error;
    });
    return error;
  }

  test("exits 1 with code internal and a hint to report a bug with --verbose", async () => {
    crash();
    const result = await run([]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toStartWith("error: boom\n");
    expect(result.stderr).toContain("--verbose");
    expect(result.stderr).toContain("bug");
  });

  test("--verbose adds the stack trace on stderr only", async () => {
    const error = crash();
    const quiet = await run(["--json"]);
    const verbose = await run(["--json", "--verbose"]);
    expect(verbose.code).toBe(1);
    expect(verbose.stdout).toBe(quiet.stdout);
    expect(quiet.stderr).toBe("");
    expect(verbose.stderr).toContain(error.stack as string);
    expect(JSON.parse(verbose.stdout).error.code).toBe("internal");
  });

  test("XrError details are error.details in JSON, next to the error block data", async () => {
    helpInformation = spyOn(
      Command.prototype,
      "helpInformation",
    ).mockImplementation(() => {
      throw new XrError({
        code: "repo-in-use",
        message: "in use",
        details: { projects: ["feat"] },
        blocks: [{ type: "value", key: "repo", value: "api" }],
      });
    });
    const result = await run(["--json"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).error).toEqual({
      code: "repo-in-use",
      message: "in use",
      details: { projects: ["feat"], repo: "api" },
    });
  });

  test("XrError report blocks sit next to error in JSON, and on stderr in text", async () => {
    helpInformation = spyOn(
      Command.prototype,
      "helpInformation",
    ).mockImplementation(() => {
      throw new XrError({
        code: "repos-failed",
        message: "1 repo failed.",
        report: [
          {
            type: "repos",
            items: [{ repo: "api", status: "failed", message: "boom" }],
          },
        ],
      });
    });
    const result = await run(["--json"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      warnings: [],
      repos: [{ repo: "api", status: "failed", message: "boom" }],
      error: { code: "repos-failed", message: "1 repo failed." },
    });
    const text = await run([]);
    expect(text.stdout).toBe("");
    expect(text.stderr).toBe("✗ api: boom\n\nerror: 1 repo failed.\n");
  });

  test("a thrown non-error under --verbose prints it as the trace", async () => {
    helpInformation = spyOn(
      Command.prototype,
      "helpInformation",
    ).mockImplementation(() => {
      throw "boom";
    });
    const result = await run(["--verbose"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`boom\nerror: boom\n${BUG_HINT}\n`);
  });
});

describe("readGlobalFlags", () => {
  const tty = { stdin: true, stdout: true };

  test("is interactive when stdin and stdout are a TTY and no flag turns it off", () => {
    expect(readGlobalFlags({ interactive: true }, tty)).toEqual({
      codebasePath: undefined,
      json: false,
      interactive: true,
      verbose: false,
    });
  });

  test("is not interactive with --json or --no-interactive", () => {
    expect(
      readGlobalFlags({ interactive: true, json: true }, tty).interactive,
    ).toBe(false);
    expect(readGlobalFlags({ interactive: false }, tty).interactive).toBe(
      false,
    );
  });

  test("is not interactive when stdin or stdout is not a TTY", () => {
    expect(
      readGlobalFlags({ interactive: true }, { stdin: false, stdout: true })
        .interactive,
    ).toBe(false);
    expect(
      readGlobalFlags({ interactive: true }, { stdin: true, stdout: false })
        .interactive,
    ).toBe(false);
  });

  test("keeps the codebase path, --json and --verbose", () => {
    expect(
      readGlobalFlags(
        { codebasePath: "/c", json: true, verbose: true, interactive: true },
        tty,
      ),
    ).toEqual({
      codebasePath: "/c",
      json: true,
      interactive: false,
      verbose: true,
    });
  });
});

describe("toXrError", () => {
  test("keeps an XrError as is", () => {
    const error = new XrError({ code: "usage", message: "x" });
    expect(toXrError(error)).toBe(error);
  });

  test("turns any other error into an internal XrError with a bug hint", () => {
    const error = toXrError(new Error("boom"));
    expect(error.code).toBe("internal");
    expect(error.message).toBe("boom");
    expect(error.hint).toContain("--verbose");
  });

  test("maps each ConfigError kind to its code and keeps message and hint", () => {
    for (const [kind, code] of [
      ["conflict", "config-conflict"],
      ["invalid", "invalid-config"],
      ["not-a-codebase", "not-a-codebase"],
    ] as const) {
      const error = toXrError(
        new ConfigError({ kind, message: "m", hint: "h" }),
      );
      expect(error).toBeInstanceOf(XrError);
      expect([error.code, error.message, error.hint]).toEqual([code, "m", "h"]);
    }
  });

  test("turns a thrown non-error into an internal XrError", () => {
    const error = toXrError("boom");
    expect(error.code).toBe("internal");
    expect(error.message).toBe("boom");
  });
});

describe("configView", () => {
  const base = {
    codebase: "/c",
    entries: [],
    projectsDir: {
      value: ".projects",
      source: { kind: "default" as const },
      resolved: "/c/.projects",
    },
    unknownKeys: [],
  };

  test("lists the merged repos in config order with camelCase fields", () => {
    const view = configView({
      ...base,
      values: {
        repos: {
          web: { remote: "w", "default-branch": "trunk", description: "site" },
          api: { remote: "a" },
        },
      },
    });
    expect(view.repos).toEqual([
      { name: "web", remote: "w", defaultBranch: "trunk", description: "site" },
      { name: "api", remote: "a" },
    ]);
  });

  test("no repos key gives an empty list, and the other fields stay", () => {
    expect(configView({ ...base, values: {} })).toEqual({
      codebase: "/c",
      entries: [],
      projectsDir: base.projectsDir,
      repos: [],
    });
  });
});
