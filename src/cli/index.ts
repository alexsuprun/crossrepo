import { Command, CommanderError } from "commander";
import { EXIT_OK, exitCodeFor, XrError } from "../errors/index.ts";
import { createOutput, pickModes, type Report } from "../output/index.ts";

export interface MainOptions {
  version: string;
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  isTTY: { stdin: boolean; stdout: boolean; stderr: boolean };
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

const USAGE_HINT = "Run `xr --help` for usage.";
const BUG_HINT =
  "This is a bug in xr. Run it again with `--verbose` and report the output at https://github.com/alexsuprun/crossrepo/issues.";

/** Runs the `xr` CLI on `argv` (without the node and script paths) and returns the exit code. */
export function main(options: MainOptions): number {
  let commanderOutput = "";
  const result: { report?: Report } = {};
  const program = createProgram(options.version, {
    write: (text) => {
      commanderOutput += text;
    },
    done: (report) => {
      result.report = report;
    },
  });

  let failure: { error: XrError; thrown: unknown } | undefined;
  try {
    program.parse([...options.argv], { from: "user" });
  } catch (thrown) {
    // commander still reads the known options when it rejects argv, so `--version` wins, as `.version()` did.
    if (
      thrown instanceof CommanderError &&
      program.opts<ParsedFlags>().version
    ) {
      result.report = versionReport(options.version);
    } else if (
      thrown instanceof CommanderError &&
      thrown.exitCode === EXIT_OK
    ) {
      result.report = {
        data: { help: commanderOutput },
        text: commanderOutput,
      };
    } else {
      failure = { error: toXrError(thrown), thrown };
    }
  }

  const flags = readGlobalFlags(program.opts<ParsedFlags>(), options.isTTY);
  const out = createOutput({
    modes: pickModes({
      json: flags.json,
      env: options.env,
      isTTY: options.isTTY,
    }),
    stdout: options.stdout,
    stderr: options.stderr,
  });
  if (!failure) {
    out.report(result.report ?? {});
    return EXIT_OK;
  }
  if (flags.verbose && failure.error.code === "internal") {
    out.trace(stackOf(failure.thrown));
  }
  out.report({ error: failure.error });
  return exitCodeFor(failure.error);
}

function createProgram(
  version: string,
  {
    write,
    done,
  }: { write: (text: string) => void; done: (report: Report) => void },
): Command {
  const program: Command = new Command("xr")
    .description(
      "Create, sync and remove the same git worktree branch across many sibling repos.",
    )
    .helpOption("-h, --help", "print this help")
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
    .action(() => {
      if (program.opts<ParsedFlags>().version) {
        done(versionReport(version));
      } else {
        const help = program.helpInformation();
        done({ data: { help }, text: help });
      }
    });
  return program;
}

function versionReport(version: string): Report {
  return { data: { version }, text: `${version}\n` };
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

/** Turns anything thrown into an `XrError`: commander errors become `usage`, the rest `internal`. */
export function toXrError(thrown: unknown): XrError {
  if (thrown instanceof XrError) {
    return thrown;
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
