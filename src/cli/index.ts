import { join, resolve } from "node:path";
import { Command, CommanderError } from "commander";
import { createFs } from "../adapters/fs/index.ts";
import { createGit } from "../adapters/git/index.ts";
import { createLock } from "../adapters/lock/index.ts";
import { codebaseInit } from "../commands/codebase/init.ts";
import { codebaseRepoAdd } from "../commands/codebase/repo/add.ts";
import { codebaseRepoList } from "../commands/codebase/repo/list.ts";
import { configShow } from "../commands/config/show.ts";
import {
  CODEBASE_PATH_HINT,
  ConfigError,
  type Discovery,
  discover,
  type LoadedConfig,
  loadConfig,
} from "../config/index.ts";
import {
  type ErrorCode,
  EXIT_OK,
  exitCodeFor,
  XrError,
} from "../errors/index.ts";
import {
  type Block,
  createOutput,
  type Output,
  pickModes,
  type Report,
} from "../output/index.ts";

export interface MainOptions {
  version: string;
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  isTTY: { stdin: boolean; stdout: boolean; stderr: boolean };
  /** The current folder. Only discovery reads it, and only without `--codebase-path`. */
  cwd: string;
  /** `os.homedir()`: the user config level and `~` in paths. */
  home: string;
  /** Ctrl-C. `bin.ts` wires it to `SIGINT`; tests fire it in-process. Default: never fires. */
  interrupts?: Interrupts;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** A Ctrl-C source, as `ctx.interrupts`. */
export type Interrupts = Ctx["interrupts"];

const NO_INTERRUPTS: Interrupts = { on: () => () => {} };

/** The global flags as commander parses them. */
export interface ParsedFlags {
  version?: boolean;
  codebasePath?: string;
  json?: boolean;
  interactive?: boolean;
  verbose?: boolean;
}

export interface GlobalFlags {
  codebasePath: string | undefined;
  json: boolean;
  /** stdin and stdout are a TTY, and neither `--json` nor `--no-interactive` is given. */
  interactive: boolean;
  verbose: boolean;
}

/** cli may not import `domain`, so it reads the command and ctx types off a command. */
type CommandUnit = typeof configShow;
type Ctx = Parameters<CommandUnit["run"]>[0];

const USAGE_HINT = "Run `xr --help` for usage.";
const BUG_HINT =
  "This is a bug in xr. Run it again with `--verbose` and report the output at https://github.com/alexsuprun/crossrepo/issues.";

/** What commander picked: a ready Report (help, version) or a command to run. */
interface Parsed {
  report?: Report;
  command?: CommandUnit;
  /** The positional arguments of `command`. */
  args?: readonly string[];
}

/** Runs the `xr` CLI on `argv` (without the node and script paths) and returns the exit code. */
export async function main(options: MainOptions): Promise<number> {
  let commanderOutput = "";
  const parsed: Parsed = {};
  const program = createProgram({
    write: (text) => {
      commanderOutput += text;
    },
    help: (text) => {
      parsed.report = helpReport(text);
    },
    select: (command, args = []) => {
      parsed.command = command;
      parsed.args = args;
    },
  });

  let failure: { error: XrError; thrown: unknown } | undefined;
  try {
    program.parse([...options.argv], { from: "user" });
  } catch (thrown) {
    if (thrown instanceof CommanderError && thrown.exitCode === EXIT_OK) {
      parsed.report = helpReport(commanderOutput);
    } else {
      failure = { error: toXrError(thrown), thrown };
    }
  }
  // commander still reads the known options when it rejects argv, so `--version` wins, as `.version()` did.
  if (
    program.opts<ParsedFlags>().version &&
    (!failure || failure.thrown instanceof CommanderError)
  ) {
    failure = undefined;
    parsed.report = {
      blocks: [{ type: "value", key: "version", value: options.version }],
    };
    parsed.command = undefined;
  }

  const flags = readGlobalFlags(program.opts<ParsedFlags>(), options.isTTY);
  let discovery: Discovery | undefined;
  if (!failure && parsed.command) {
    try {
      discovery = checkKind(
        parsed.command,
        discover(resolve(options.cwd, flags.codebasePath ?? ".")),
      );
    } catch (thrown) {
      failure = { error: toXrError(thrown), thrown };
    }
  }

  const out = createOutput({
    modes: pickModes({
      json: flags.json,
      env: options.env,
      isTTY: options.isTTY,
    }),
    stdout: options.stdout,
    stderr: options.stderr,
    home: options.home,
    // A folder that is not a codebase yet shows its paths relative to `~`.
    codebase: discovery?.kind === "none" ? undefined : discovery?.codebase,
  });
  if (!failure) {
    try {
      const report =
        parsed.command && discovery
          ? await runCommand(
              parsed.command,
              parsed.args ?? [],
              discovery,
              flags,
              options,
              out,
            )
          : (parsed.report ?? { blocks: [] });
      out.report(report);
      return EXIT_OK;
    } catch (thrown) {
      failure = { error: toXrError(thrown), thrown };
    }
  }
  if (flags.verbose && failure.error.code === "internal") {
    out.trace(stackOf(failure.thrown));
  }
  const { code, message, hint, blocks } = failure.error;
  out.report({
    blocks: [],
    error: {
      code,
      message,
      hint: hint ?? (code === "internal" ? BUG_HINT : undefined),
      // `errors` types its blocks loosely, since it may not import the Report types.
      blocks: blocks as Block[] | undefined,
    },
  });
  return exitCodeFor(failure.error);
}

/** Loads the config once, emits one warning per unknown key, builds `ctx` and runs the command. */
async function runCommand(
  command: CommandUnit,
  args: readonly string[],
  discovery: Discovery,
  flags: GlobalFlags,
  { home, env, cwd, isTTY, stderr, interrupts = NO_INTERRUPTS }: MainOptions,
  out: Output,
): Promise<Report> {
  // A folder that is not a codebase has no codebase levels, so only the user level loads.
  const config = loadConfig({
    home,
    codebase: discovery.kind === "none" ? undefined : discovery.codebase,
  });
  for (const unknown of config.unknownKeys) {
    out.emit({
      type: "warning",
      warning: {
        code: "unknown-config-key",
        message: `Unknown config key \`${unknown.key}\` in ${unknown.files.join(", ")}.`,
        hint: `did you mean ${unknown.suggestion}?`,
      },
    });
  }
  const ctx: Ctx = {
    out: { emit: (event) => out.emit(event) },
    fs: createFs(),
    // git's own output (clone) goes to stderr, so stdout keeps only the Report (AD-4).
    git: createGit({
      interactive: flags.interactive,
      env,
      stderr,
      progress: isTTY.stderr,
    }),
    config: configView(config),
    discovery,
    cwd,
    interactive: flags.interactive,
    lock: { path: lockPath(discovery), adapter: createLock() },
    interrupts,
    stepDelayMs: stepDelay(env.XR_TEST_STEP_DELAY_MS),
  };
  return command.run(ctx, args);
}

/** The merged config as commands see it: the loaded config plus `repos` in config order. */
export function configView({
  codebase,
  entries,
  projectsDir,
  values,
}: LoadedConfig): Ctx["config"] {
  return {
    codebase,
    entries,
    projectsDir,
    repos: Object.entries(values.repos ?? {}).map(([name, repo]) => ({
      name,
      remote: repo.remote,
      defaultBranch: repo["default-branch"],
      description: repo.description,
    })),
  };
}

/** `<codebase>/.crossrepo/xr.lock`; a folder that is not a codebase yet uses its own `.crossrepo/`. */
function lockPath(discovery: Discovery): string {
  const codebase =
    discovery.kind === "none" ? discovery.dir : discovery.codebase;
  return join(codebase, ".crossrepo", "xr.lock");
}

/** `XR_TEST_STEP_DELAY_MS`, for the smoke test of Ctrl-C. Anything but a positive number is no delay. */
function stepDelay(value: string | undefined): number | undefined {
  const ms = Number(value);
  return value && Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/**
 * `cli` checks the folder kind, so commands never do (AD-9). A command may give
 * its own error for a kind it refuses; the default is `not-a-codebase`.
 */
function checkKind(command: CommandUnit, discovery: Discovery): Discovery {
  if (command.accepts.includes(discovery.kind)) {
    return discovery;
  }
  if (command.refuse) throw command.refuse(discovery, createFs());
  throw new XrError({
    code: "not-a-codebase",
    message:
      discovery.kind === "none"
        ? `${discovery.dir} is not a crossrepo codebase or project.`
        : `${discovery.dir} is a ${discovery.kind}, and this command needs a codebase.`,
    hint: CODEBASE_PATH_HINT,
  });
}

interface ProgramHooks {
  write: (text: string) => void;
  help: (text: string) => void;
  select: (command: CommandUnit, args?: readonly string[]) => void;
}

function createProgram({ write, help, select }: ProgramHooks): Command {
  const program: Command = new Command("xr")
    .description(
      "Create, sync and remove the same git worktree branch across many sibling repos.",
    )
    .helpOption("-h, --help", "print this help")
    .helpCommand(false)
    .option("-V, --version", "print the version")
    .option("--codebase-path <path>", "path to the codebase")
    .option("--json", "print the result as one JSON object")
    .option("--no-interactive", "never ask questions")
    .option("--verbose", "print the stack trace of an internal error")
    .exitOverride()
    .configureOutput({
      writeOut: write,
      writeErr: write,
      outputError: () => {},
    })
    .action(() => help(program.helpInformation()));

  const config: Command = program
    .command("config")
    .description("show the config")
    .helpOption("-h, --help", "print this help")
    .action(() => help(config.helpInformation()));
  config
    .command("show")
    .description("print the merged config and the file that gives each value")
    .helpOption("-h, --help", "print this help")
    .action(() => select(configShow));

  const codebase: Command = program
    .command("codebase")
    .description("set up and change the codebase")
    .helpOption("-h, --help", "print this help")
    .action(() => help(codebase.helpInformation()));
  codebase
    .command("init")
    .description("make this folder a codebase of the git repos in it")
    .helpOption("-h, --help", "print this help")
    .action(() => select(codebaseInit));
  const repo: Command = codebase
    .command("repo")
    .description("manage the repos of the codebase")
    .helpOption("-h, --help", "print this help")
    .action(() => help(repo.helpInformation()));
  repo
    .command("list")
    .description("print each repo of the codebase and whether it is on disk")
    .helpOption("-h, --help", "print this help")
    .action(() => select(codebaseRepoList));
  const add: Command = repo
    .command("add")
    .description(
      "clone a repo into the codebase, or add a repo folder that is already in it",
    )
    .usage("[options] <url> [name] | <folder>")
    // Both are optional for commander, so a missing one is our `usage` error.
    .argument(
      "[url|folder]",
      "a git URL to clone, or a repo folder in the codebase",
    )
    .argument(
      "[name]",
      "the repo name for a URL; default: the last part of the URL",
    )
    .allowExcessArguments(false)
    .helpOption("-h, --help", "print this help")
    .action(() => select(codebaseRepoAdd, add.args));
  return program;
}

function helpReport(help: string): Report {
  return { blocks: [{ type: "value", key: "help", value: help }] };
}

/** Reads the 4 global flags and computes `interactive` once. */
export function readGlobalFlags(
  parsed: ParsedFlags,
  isTTY: { stdin: boolean; stdout: boolean },
): GlobalFlags {
  const json = parsed.json === true;
  return {
    codebasePath: parsed.codebasePath,
    json,
    interactive:
      isTTY.stdin && isTTY.stdout && !json && parsed.interactive !== false,
    verbose: parsed.verbose === true,
  };
}

function stackOf(thrown: unknown): string {
  return thrown instanceof Error && thrown.stack
    ? thrown.stack
    : String(thrown);
}

const CONFIG_ERROR_CODES: Record<ConfigError["kind"], ErrorCode> = {
  conflict: "config-conflict",
  invalid: "invalid-config",
  "not-a-codebase": "not-a-codebase",
};

/**
 * Turns anything thrown into an `XrError`: a `ConfigError` keeps its meaning,
 * commander errors become `usage`, the rest `internal`.
 */
export function toXrError(thrown: unknown): XrError {
  if (thrown instanceof XrError) {
    return thrown;
  }
  if (thrown instanceof ConfigError) {
    return new XrError({
      code: CONFIG_ERROR_CODES[thrown.kind],
      message: thrown.message,
      hint: thrown.hint,
    });
  }
  if (thrown instanceof CommanderError) {
    return new XrError({
      code: "usage",
      message: thrown.message.replace(/^error: /, ""),
      hint: USAGE_HINT,
    });
  }
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  return new XrError({ code: "internal", message, hint: BUG_HINT });
}
