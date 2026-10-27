import { join, resolve } from "node:path";
import { Command, CommanderError } from "commander";
import { createFs } from "../adapters/fs/index.ts";
import { createGit } from "../adapters/git/index.ts";
import { createHooks } from "../adapters/hooks/index.ts";
import { createLock } from "../adapters/lock/index.ts";
import { createMultiPrompt, createPrompt } from "../adapters/prompt/index.ts";
import { codebaseClone } from "../commands/codebase/clone.ts";
import { codebaseDoctor } from "../commands/codebase/doctor.ts";
import { codebaseInit } from "../commands/codebase/init.ts";
import { codebasePull } from "../commands/codebase/pull.ts";
import { codebaseRepoAdd } from "../commands/codebase/repo/add.ts";
import { codebaseRepoList } from "../commands/codebase/repo/list.ts";
import { codebaseRepoRemove } from "../commands/codebase/repo/remove.ts";
import { configShow } from "../commands/config/show.ts";
import { xrDoctor } from "../commands/doctor/doctor.ts";
import { projectCreate } from "../commands/project/create.ts";
import { projectDoctor } from "../commands/project/doctor.ts";
import { projectInfo } from "../commands/project/info.ts";
import { projectList } from "../commands/project/list.ts";
import { projectRemove } from "../commands/project/remove.ts";
import { projectRepoAdd } from "../commands/project/repo/add.ts";
import { projectRepoList } from "../commands/project/repo/list.ts";
import { projectRepoRemove } from "../commands/project/repo/remove.ts";
import { projectSync } from "../commands/project/sync.ts";
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
  /** Default `process.platform`; tests fix it. */
  platform?: NodeJS.Platform;
  /** Default the system clock; tests fix it. */
  now?: () => Date;
  /** Changes the process's current folder. Default `process.chdir`; tests pass a fake. */
  chdir?: (dir: string) => void;
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
  /** The own options of `command`, as commander gives them. */
  options?: Readonly<Record<string, unknown>>;
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
    select: (command, args = [], options = {}) => {
      parsed.command = command;
      parsed.args = args;
      parsed.options = options;
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
    sameScreen: options.isTTY.stdout && options.isTTY.stderr,
    home: options.home,
    // A folder that is not a codebase yet shows its paths relative to `~`.
    codebase:
      discovery && "codebase" in discovery ? discovery.codebase : undefined,
  });
  if (!failure) {
    try {
      const report =
        parsed.command && discovery
          ? await runCommand(
              parsed.command,
              parsed.args ?? [],
              parsed.options ?? {},
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
  const { code, message, hint, details, blocks, report } = failure.error;
  out.report({
    // `errors` types its blocks loosely, since it may not import the Report types.
    blocks: (report ?? []) as Block[],
    error: {
      code,
      message,
      hint: hint ?? (code === "internal" ? BUG_HINT : undefined),
      details,
      blocks: blocks as Block[] | undefined,
    },
  });
  return exitCodeFor(failure.error);
}

/**
 * Loads the config once, emits one warning per unknown key unless the command
 * reports them itself, builds `ctx` and runs the command.
 */
async function runCommand(
  command: CommandUnit,
  args: readonly string[],
  options: Readonly<Record<string, unknown>>,
  discovery: Discovery,
  flags: GlobalFlags,
  {
    home,
    env,
    cwd,
    isTTY,
    stderr,
    interrupts = NO_INTERRUPTS,
    platform = process.platform,
    now = () => new Date(),
    chdir = (dir) => process.chdir(dir),
  }: MainOptions,
  out: Output,
): Promise<Report> {
  // A folder with no codebase (also a broken project) has no codebase levels, so only the user level loads.
  const config = loadConfig({
    home,
    codebase: "codebase" in discovery ? discovery.codebase : undefined,
  });
  for (const unknown of command.reportsUnknownKeys ? [] : config.unknownKeys) {
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
    prompt: {
      ...createPrompt({ interactive: flags.interactive }),
      ...createMultiPrompt({ interactive: flags.interactive }),
    },
    lock: { path: lockPath(discovery), adapter: createLock() },
    interrupts,
    stepDelayMs: stepDelay(env.XR_TEST_STEP_DELAY_MS),
    // Hook output goes to stderr in every mode, so stdout keeps only the Report (AD-4).
    hooks: createHooks({ platform, env, write: stderr }),
    env,
    platform,
    now,
    chdir,
  };
  return command.run(ctx, args, options);
}

/** The merged config as commands see it: the loaded config plus `repos` in config order. */
export function configView({
  codebase,
  entries,
  projectsDir,
  values,
  unknownKeys,
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
    ...(values.name === undefined ? {} : { name: values.name }),
    postCreate: values.project?.["post-create"] ?? [],
    preRemove: values.project?.["pre-remove"] ?? [],
    vars: values.project?.vars ?? {},
    unknownKeys,
  };
}

/** `<codebase>/.crossrepo/xr.lock`; a folder with no codebase uses its own `.crossrepo/`. */
function lockPath(discovery: Discovery): string {
  const codebase = "codebase" in discovery ? discovery.codebase : discovery.dir;
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
  // Only a command that accepts a broken project gets past its discovery error.
  if (discovery.kind === "broken-project") throw discovery.error;
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
  select: (
    command: CommandUnit,
    args?: readonly string[],
    options?: Readonly<Record<string, unknown>>,
  ) => void;
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

  program
    .command("doctor")
    .description(
      "check the codebase or the project of this folder; print each problem with its fix",
    )
    .allowExcessArguments(false)
    .helpOption("-h, --help", "print this help")
    .action(() => select(xrDoctor));

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
  codebase
    .command("clone")
    .description("clone each repo of the codebase that is not on disk")
    .allowExcessArguments(false)
    .helpOption("-h, --help", "print this help")
    .action(() => select(codebaseClone));
  codebase
    .command("pull")
    .description(
      "fast-forward the checked-out branch of each repo of the codebase on disk",
    )
    .allowExcessArguments(false)
    .helpOption("-h, --help", "print this help")
    .action(() => select(codebasePull));
  codebase
    .command("doctor")
    .description(
      "check the codebase config, repo folders and AGENTS.md; print each problem with its fix",
    )
    .allowExcessArguments(false)
    .helpOption("-h, --help", "print this help")
    .action(() => select(codebaseDoctor));
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
    // Both are optional for commander, so a missing one opens our picker or gives `missing-argument`.
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
  const remove: Command = repo
    .command("remove")
    .description(
      "remove a repo from the codebase config and AGENTS.md, and delete its folder",
    )
    // Optional for commander, so a missing name opens our picker or gives `missing-argument`.
    .argument("[name]", "the name of the repo in the codebase config")
    .option("--keep-folder", "keep the repo folder; remove only the entry")
    .option(
      "--force",
      "delete the folder even when it has work that is not pushed",
    )
    .allowExcessArguments(false)
    .helpOption("-h, --help", "print this help")
    .action(() => select(codebaseRepoRemove, remove.args, remove.opts()));

  const project: Command = program
    .command("project")
    .description("make and change projects")
    .helpOption("-h, --help", "print this help")
    .action(() => help(project.helpInformation()));
  const create: Command = project
    .command("create")
    .description(
      "make a project folder with a worktree of each chosen repo on one branch",
    )
    .usage("[options] <branch> [repo...] | <branch> --all")
    .argument("<branch>", "the branch of the project")
    // Optional for commander, so no repo and no `--all` opens our picker or gives `missing-argument`.
    .argument("[repo...]", "the repos of the project; default: pick them")
    .option("--all", "use every repo of the codebase")
    .helpOption("-h, --help", "print this help")
    .action(() => select(projectCreate, create.args, create.opts()));
  project
    .command("list")
    .description("print each project of the codebase with its branch and repos")
    .allowExcessArguments(false)
    .helpOption("-h, --help", "print this help")
    .action(() => select(projectList));
  const info: Command = project
    .command("info")
    .description("print the branch, folder and repos of one project")
    // Optional for commander: in a project folder, no name means that project.
    .argument(
      "[project]",
      "the project folder name or branch; default: the current project",
    )
    .allowExcessArguments(false)
    .helpOption("-h, --help", "print this help")
    .action(() => select(projectInfo, info.args));
  const sync: Command = project
    .command("sync")
    .description(
      "fetch origin and merge the default branch into each worktree of one project",
    )
    // Optional for commander, so a missing project opens our picker or gives `missing-argument`.
    .argument(
      "[project]",
      "the project folder name or branch; default: the current project",
    )
    .allowExcessArguments(false)
    .helpOption("-h, --help", "print this help")
    .action(() => select(projectSync, sync.args));
  const doctor: Command = project
    .command("doctor")
    .description(
      "check one project and its codebase, and give a fix for each problem",
    )
    // Optional for commander, so a missing project opens our picker or gives `missing-argument`.
    .argument(
      "[project]",
      "the project folder name or branch; default: the current project",
    )
    .allowExcessArguments(false)
    .helpOption("-h, --help", "print this help")
    .action(() => select(projectDoctor, doctor.args));
  const removeProject: Command = project
    .command("remove")
    .description(
      "remove the worktrees and the folder of one project; keep the branches",
    )
    // Optional for commander, so a missing project opens our picker or gives `missing-argument`.
    .argument("[project]", "the project folder name or branch")
    .option(
      "--force",
      "remove worktrees even when they have uncommitted changes",
    )
    .option(
      "--delete-branch",
      "also delete each merged branch with `git branch -d`",
    )
    .allowExcessArguments(false)
    .helpOption("-h, --help", "print this help")
    .action(() =>
      select(projectRemove, removeProject.args, removeProject.opts()),
    );
  const projectRepo: Command = project
    .command("repo")
    .description("change and list the repos of a project")
    .helpOption("-h, --help", "print this help")
    .action(() => help(projectRepo.helpInformation()));
  const PROJECT_FLAG = "--project <project>";
  const PROJECT_TEXT =
    "the project folder name or branch; default: the current project";
  const repoAdd: Command = projectRepo
    .command("add")
    .description("add a worktree of each repo to the project")
    // Optional for commander, so no repo opens our picker or gives `missing-argument`.
    .argument("[repos...]", "the repos to add; default: pick them")
    .option(PROJECT_FLAG, PROJECT_TEXT)
    .helpOption("-h, --help", "print this help")
    .action(() => select(projectRepoAdd, repoAdd.args, repoAdd.opts()));
  const repoRemove: Command = projectRepo
    .command("remove")
    .description("remove the worktree of each repo from the project")
    // Optional for commander, so no repo opens our picker or gives `missing-argument`.
    .argument("[repos...]", "the repos to remove; default: pick them")
    .option(PROJECT_FLAG, PROJECT_TEXT)
    .option(
      "--force",
      "remove worktrees even when they have uncommitted changes",
    )
    .option(
      "--delete-branch",
      "also delete each merged branch with `git branch -d`",
    )
    .helpOption("-h, --help", "print this help")
    .action(() =>
      select(projectRepoRemove, repoRemove.args, repoRemove.opts()),
    );
  const repoList: Command = projectRepo
    .command("list")
    .description(
      "print each repo of the project and whether its worktree folder exists",
    )
    .option(PROJECT_FLAG, PROJECT_TEXT)
    .allowExcessArguments(false)
    .helpOption("-h, --help", "print this help")
    .action(() => select(projectRepoList, [], repoList.opts()));
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
