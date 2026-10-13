import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Ctx } from "../../src/domain/ctx.ts";
import { writeCodebaseSection } from "../../src/services/agents-md.ts";

/** An in-memory `ctx.fs` that records each write. */
function fakeFs(files: Record<string, string> = {}) {
  const writes: { path: string; text: string }[] = [];
  const fs: Ctx["fs"] = {
    readText: (path) => files[path],
    writeText: (path, text) => {
      writes.push({ path, text });
      files[path] = text;
    },
    mkdir: () => {},
    remove: () => {},
    listDirs: () => [],
    exists: (path) => path in files,
  };
  return { fs, files, writes };
}

const CODEBASE = join("/work", "shop");
const AGENTS = join(CODEBASE, "AGENTS.md");

describe("writeCodebaseSection", () => {
  test("no file: creates AGENTS.md with only the section and returns undefined", () => {
    const { fs, writes } = fakeFs();
    expect(writeCodebaseSection(fs, CODEBASE, [{ name: "api" }])).toBe(
      undefined,
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe(AGENTS);
    expect(writes[0]?.text).toStartWith("## Codebase\n\n");
    expect(writes[0]?.text).toEndWith("- `api`\n");
  });

  test("replaces the section, keeps the rest and returns the old text", () => {
    const old =
      "# Agents\r\n\r\n## Codebase\r\n\r\nold\r\n\r\n## Repos\r\n\r\nr\r\n";
    const { fs, files } = fakeFs({ [AGENTS]: old });
    expect(
      writeCodebaseSection(fs, CODEBASE, [
        { name: "api", description: "Payments API" },
      ]),
    ).toBe(old);
    const text = files[AGENTS] ?? "";
    expect(text).toStartWith("# Agents\r\n\r\n## Codebase\r\n");
    expect(text).toContain(
      "- `api` — Payments API\r\n\r\n## Repos\r\n\r\nr\r\n",
    );
    expect(text.replaceAll("\r\n", "")).not.toContain("\n");
  });

  test("does not write when the text would not change", () => {
    const { fs, writes } = fakeFs();
    writeCodebaseSection(fs, CODEBASE, []);
    writeCodebaseSection(fs, CODEBASE, []);
    expect(writes).toHaveLength(1);
  });

  test("never touches CLAUDE.md", () => {
    const { fs, writes } = fakeFs({ [join(CODEBASE, "CLAUDE.md")]: "x" });
    writeCodebaseSection(fs, CODEBASE, []);
    expect(writes.map((write) => write.path)).toEqual([AGENTS]);
  });
});
