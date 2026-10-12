import { resolve } from "node:path";
import { Command, CommanderError } from "commander";
import { configShow } from "../commands/config/show.ts";
import {
  CODEBASE_PATH_HINT,
  ConfigError,
  type Discovery,
  discover,
  loadConfig,
} from "../config/index.ts";
import {
  type ErrorCode,
  EXIT_OK,
  exitCodeFor,
  XrError,
} from "../errors/index.ts";
import {
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
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

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
}

/** Runs the `xr` CLI on `argv` (without the node and script paths) and returns the exit code. */
export function main(options: MainOptions): number {
  let commanderOutput = "";
  const parsed: Parsed = {};
  const program = createProgram({
    write: (text) => {
      commanderOutput += text;
    },
    help: (text) => {
      parsed.report = helpReport(text);
    },
    select: (command) => {
      parsed.command = command;
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
  let discovery: FoundCodebase | undefined;
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
    codebase: discovery?.codebase,
  });
  if (!failure) {
    try {
      const report =
        parsed.command && discovery
          ? runCommand(parsed.command, discovery, flags, options.home, out)
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
  const { code, message, hint } = failure.error;
  out.report({ blocks: [], error: { code, message, hint } });
  return exitCodeFor(failure.error);
}

/** Loads the config once, emits one warning per unknown key, builds `ctx` and runs the command. */
function runCommand(
  command: CommandUnit,
  discovery: FoundCodebase,
  flags: GlobalFlags,
  home: string,
  out: Output,
): Report {
  const config = loadConfig({ home, codebase: discovery.codebase });
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
    config,
    discovery,
    interactive: flags.interactive,
  };
  return command.run(ctx);
}

type FoundCodebase = Exclude<Discovery, { kind: "none" }>;

/**
 * `cli` checks the folder kind, so commands never do (AD-9). No command accepts
 * `none` yet, and the config load needs a codebase.
 */
function checkKind(command: CommandUnit, discovery: Discovery): FoundCodebase {
  if (discovery.kind !== "none" && command.accepts.includes(discovery.kind)) {
    return discovery;
  }
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
  select: (command: CommandUnit) => void;
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
