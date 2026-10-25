import type { Ctx, HookResult, Leftover, Tx } from "../domain/ctx.ts";
import { hookStepLabel, lastLines } from "../domain/project.ts";
import type { Block } from "../domain/report.ts";
import { XrError } from "../errors/index.ts";

/** The project hooks of the config. */
export type HookName = "post-create" | "pre-remove";

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
