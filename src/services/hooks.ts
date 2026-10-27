import type { Ctx, HookResult, Leftover, Tx } from "../domain/ctx.ts";
import { type HookName, hookStepLabel, lastLines } from "../domain/project.ts";
import type { Block, Warning } from "../domain/report.ts";
import { XrError } from "../errors/index.ts";

const HOOK_OUTPUT_LINES = 20;

/**
 * One `tx.step` per hook line, in order, each a `sh -c` in `cwd`. The first
 * failed line throws `hook-failed`. The undo does nothing: undo never runs a
 * hook (D14), and a line makes nothing that xr owns.
 */
export async function runHookSteps(
  ctx: Pick<Ctx, "hooks">,
  tx: Tx,
  hook: HookName,
  lines: readonly string[],
  {
    cwd,
    env,
    cleanup,
  }: {
    cwd: string;
    env: Readonly<Record<string, string>>;
    /** The leftover of a line that a second Ctrl-C leaves. */
    cleanup: (command: string) => Leftover;
  },
): Promise<void> {
  for (const command of lines) {
    await tx.step(
      hookStepLabel(hook, command),
      async (signal) => {
        const result = await ctx.hooks.run({ command, cwd, env, signal });
        if (!result.ok) throw hookFailed(hook, command, result);
      },
      () => {},
      cleanup(command),
    );
  }
}

/** `hook-failed` for one failed hook line, with the last 20 output lines. */
export function hookFailed(
  hook: HookName,
  command: string,
  result: Exclude<HookResult, { ok: true }>,
): XrError {
  const why = result.timedOut
    ? "timed out after 10 minutes"
    : result.exitCode === null
      ? "was stopped by a signal"
      : `failed with exit code ${result.exitCode}`;
  const output = lastLines(result.output, HOOK_OUTPUT_LINES);
  const blocks: Block[] = [
    {
      type: "section",
      key: "hookOutput",
      title: "Hook output",
      blocks: [{ type: "value", key: "lines", value: output }],
    },
  ];
  return new XrError({
    code: "hook-failed",
    message: `The ${hook} hook \`${command}\` ${why}.`,
    hint: `Fix the line in \`project.${hook}\` of the config, then run the command again.`,
    details: { command, exitCode: result.exitCode, timedOut: result.timedOut },
    blocks,
  });
}

/**
 * The `hook-failed` warning of a `post-remove` that did not end well, after the
 * project is removed: `error` is the `hook-failed` of a line, or the
 * `interrupted` of a Ctrl-C, whose cause is the `hook-failed` of the stopped
 * line when one ran. `notRun` starts with the line that failed or would run
 * next. Gives `undefined` for any other error.
 */
export function hookWarning(
  hook: HookName,
  error: unknown,
  notRun: readonly string[],
): Warning | undefined {
  if (!(error instanceof XrError)) return undefined;
  const names = notRun.map((command) => `\`${command}\``).join(", ");
  if (error.code === "hook-failed") {
    return {
      code: "hook-failed",
      message: error.message,
      hint: `The project is removed. Fix the line in \`project.${hook}\`, then run by hand the lines that did not run: ${names}.`,
      ...outputLines(error),
    };
  }
  if (error.code !== "interrupted") return undefined;
  const { cause } = error;
  return {
    code: "hook-failed",
    message:
      cause === undefined
        ? `The ${hook} hook was stopped by Ctrl-C before ${names} ran.`
        : `The ${hook} hook \`${notRun[0]}\` was stopped by Ctrl-C.`,
    hint: `The project is removed. Run by hand the lines that did not run, if they are needed: ${names}.`,
    ...(cause instanceof XrError && cause.code === "hook-failed"
      ? outputLines(cause)
      : {}),
  };
}

/** `{ lines }` from the `hookOutput` block of a `hookFailed` error; empty when the line printed nothing. */
function outputLines(error: XrError): { lines?: string[] } {
  const lines = hookOutputLines(error);
  return lines.length ? { lines } : {};
}

/** The output lines in the `hookOutput` block of a `hookFailed` error. */
function hookOutputLines(error: XrError): string[] {
  for (const block of (error.blocks ?? []) as Block[]) {
    if (block.type !== "section" || block.key !== "hookOutput") continue;
    for (const inner of block.blocks) {
      if (inner.type === "value" && typeof inner.value === "string") {
        return inner.value === "" ? [] : inner.value.split("\n");
      }
    }
  }
  return [];
}
