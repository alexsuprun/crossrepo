#!/usr/bin/env bun
/**
 * Runs every check in parallel and prints one `name - ok` line each.
 * A failing check keeps its output, and the other checks still run.
 */

import { availableParallelism } from "node:os";
import { dirname } from "node:path";

export interface Check {
  /** Label shown in the report. */
  name: string;
  /** package.json script to run, so the command itself has one definition. */
  script: string;
}

export interface CheckResult {
  name: string;
  script: string;
  ok: boolean;
  output: string;
  ms: number;
}

export type Spawn = (check: Check) => Promise<{ ok: boolean; output: string }>;

/** Cheap checks come first, so they start while the slow ones queue. */
export const CHECKS: Check[] = [
  { name: "lint", script: "lint" },
  { name: "typecheck", script: "typecheck" },
  { name: "test", script: "test" },
  { name: "smoke", script: "test:smoke" },
];

/** Lines of a failing check's output to keep before truncating. */
const MAX_LINES = 200;

const HELP = `usage: validate.ts [options]

Run every validation check in parallel and stay quiet unless one fails.

options:
  -j, --jobs N     checks to run at once (default: CPU count)
      --full       do not truncate a failing check's output
      --list       print the check names and exit
  -h, --help       show this help message and exit

checks:
${CHECKS.map((c) => `  ${c.name.padEnd(10)} bun run ${c.script}`).join("\n")}`;

export async function run(
  argv: string[],
  options: { projectRoot?: string; checks?: Check[]; spawn?: Spawn } = {},
): Promise<number> {
  const checks = options.checks ?? CHECKS;
  let jobs = availableParallelism();
  let maxLines = MAX_LINES;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    switch (arg) {
      case "--full": {
        maxLines = 0;
        break;
      }
      case "--list": {
        console.log(checks.map((c) => c.name).join("\n"));
        return 0;
      }
      case "-h":
      case "--help": {
        console.log(HELP);
        return 0;
      }
      case "-j":
      case "--jobs": {
        const value = Number(argv[++i]);
        if (!Number.isInteger(value) || value < 1) {
          console.error("error: --jobs needs a positive integer");
          return 2;
        }
        jobs = value;
        break;
      }
      default: {
        console.error(`error: unrecognized argument: ${arg}`);
        return 2;
      }
    }
  }

  const projectRoot = options.projectRoot ?? dirname(import.meta.dir);
  const spawn =
    options.spawn ?? ((check: Check) => spawnScript(check, projectRoot));
  const results = await runChecks(checks, { jobs, spawn });
  // Always stdout: on stderr a terminal paints the whole report, passing lines included, as an error.
  const color = process.stdout.isTTY === true && !process.env.NO_COLOR;
  console.log(formatReport(results, { maxLines, color }));
  return results.some((r) => !r.ok) ? 1 : 0;
}

/** Run the checks with at most `jobs` in flight, results in check order. */
export async function runChecks(
  checks: Check[],
  options: { jobs: number; spawn: Spawn },
): Promise<CheckResult[]> {
  const results: CheckResult[] = Array.from({ length: checks.length });
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < checks.length) {
      const index = next++;
      const check = checks[index];
      if (!check) break;
      const started = Bun.nanoseconds();
      let outcome: { ok: boolean; output: string };
      try {
        outcome = await options.spawn(check);
      } catch (error) {
        outcome = { ok: false, output: String(error) };
      }
      results[index] = {
        name: check.name,
        script: check.script,
        ...outcome,
        ms: Math.round((Bun.nanoseconds() - started) / 1e6),
      };
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(options.jobs, checks.length) }, () =>
      worker(),
    ),
  );
  return results;
}

/** A status line per check, plus the output of any that failed. */
export function formatReport(
  results: CheckResult[],
  options: { maxLines?: number; color?: boolean } = {},
): string {
  const paint = (text: string, code: number) =>
    options.color ? `\u001B[${code}m${text}\u001B[0m` : text;
  const red = (text: string) => paint(text, 31);
  const green = (text: string) => paint(text, 32);

  const width = Math.max(...results.map((r) => r.name.length));
  const status = results.map(
    (r) => `${r.name.padEnd(width)} - ${r.ok ? green("ok") : red("❌ FAIL")}`,
  );

  const failures = results.filter((r) => !r.ok);
  if (failures.length === 0) return status.join("\n");

  // A check's own output and the summary stay plain: that text carries its own meaning.
  const maxLines = options.maxLines ?? MAX_LINES;
  const details = failures.map(
    (f) =>
      `${red(`--- FAIL: ${f.name} (bun run ${f.script}) ---`)}\n${clip(f.output, maxLines)}`,
  );
  const summary = `${failures.length} of ${results.length} checks failed: ${failures.map((f) => f.name).join(", ")}`;
  return [status.join("\n"), ...details, summary].join("\n\n");
}

/** Keep the head of `text` — the first error is what matters, not the tail. */
function clip(text: string, maxLines: number): string {
  const trimmed = text.trimEnd();
  if (maxLines <= 0) return trimmed;
  const lines = trimmed.split("\n");
  if (lines.length <= maxLines) return trimmed;
  const dropped = lines.length - maxLines;
  return `${lines.slice(0, maxLines).join("\n")}\n... ${dropped} more lines (rerun with --full)`;
}

/** Drops `GIT_*` so a check run from a git hook cannot write to the hook's repo. */
export function checkEnv(
  parent: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
  }
  // Colour codes are pure noise in a captured buffer.
  return { ...env, NO_COLOR: "1", FORCE_COLOR: "0", CI: parent.CI ?? "" };
}

/** Run one package.json script, merging its stdout and stderr. */
async function spawnScript(
  check: Check,
  projectRoot: string,
): Promise<{ ok: boolean; output: string }> {
  const child = Bun.spawn(["bun", "run", "--silent", check.script], {
    cwd: projectRoot,
    env: checkEnv(process.env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {
    ok: code === 0,
    output: [stdout, stderr].filter(Boolean).join("\n"),
  };
}

if (import.meta.main) {
  process.exitCode = await run(Bun.argv.slice(2), {
    projectRoot: dirname(import.meta.dir),
  });
}
