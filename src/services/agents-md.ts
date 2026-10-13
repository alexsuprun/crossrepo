import { join } from "node:path";
import {
  type CodebaseRepo,
  detectEol,
  findSections,
  renderCodebaseSection,
  spliceSection,
} from "../domain/agents-md.ts";
import type { Ctx } from "../domain/ctx.ts";

/**
 * Writes the `## Codebase` section of `<codebaseDir>/AGENTS.md` and leaves the
 * rest of the file as it is. Returns the old text, or `undefined` when the file
 * did not exist, so a caller can undo.
 */
export function writeCodebaseSection(
  fs: Ctx["fs"],
  codebaseDir: string,
  repos: readonly CodebaseRepo[],
): string | undefined {
  const path = join(codebaseDir, "AGENTS.md");
  const old = fs.readText(path);
  const text = old ?? "";
  const next = spliceSection(
    text,
    findSections(text).codebase,
    renderCodebaseSection(repos, detectEol(text)),
  );
  if (next !== old) fs.writeText(path, next);
  return old;
}
