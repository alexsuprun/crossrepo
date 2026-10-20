import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Ctx, Leftover, Tx } from "../../src/domain/ctx.ts";
import {
  codebaseAgentsText,
  projectAgentsText,
  writeAgentsStep,
  writeAgentsText,
} from "../../src/services/agents-md.ts";

/** An in-memory `ctx.fs` that records each write. */
function fakeFs(files: Record<string, string> = {}) {
  const writes: { path: string; text: string }[] = [];
  const removes: string[] = [];
  const fs: Ctx["fs"] = {
    readText: (path) => files[path],
    writeText: (path, text) => {
      writes.push({ path, text });
      files[path] = text;
    },
    mkdir: () => {},
    remove: (path) => {
      removes.push(path);
      delete files[path];
    },
    listDirs: () => [],
    exists: (path) => path in files,
    realpath: (path) => path,
    stat: () => undefined,
  };
  return { fs, files, writes, removes };
}

const CODEBASE = join("/work", "shop");
const AGENTS = join(CODEBASE, "AGENTS.md");

/** Writes `## Codebase` of `<dir>/AGENTS.md`. */
function writeCodebaseSection(
  fs: Ctx["fs"],
  dir: string,
  repos: { name: string; description?: string }[],
): string | undefined {
  return writeAgentsText(
    fs,
    join(dir, "AGENTS.md"),
    codebaseAgentsText(fs, dir, repos),
  );
}

describe("codebaseAgentsText and writeAgentsText", () => {
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

const PROJECT = join("/work", "projects", "feat--x");
const PROJECT_AGENTS = join(PROJECT, "AGENTS.md");
const CODEBASE_TEXT = [
  "# Agents",
  "",
  "Intro.",
  "",
  "## Codebase",
  "",
  "old",
  "",
  "## Repos",
  "",
  "Pre.",
  "",
  "### API",
  "",
  "api text",
  "",
  "### web",
  "",
  "web text",
  "",
  "### docs",
  "",
  "docs text",
  "",
  "## Other",
  "",
  "other",
  "",
].join("\n");
const CONFIG = [
  { name: "docs", description: "Docs" },
  { name: "web", description: "" },
  { name: "api", description: "The HTTP API" },
  { name: "cli" },
];

describe("projectAgentsText", () => {
  test("new project: a copy of the codebase file with only the two sections changed", () => {
    const { fs } = fakeFs({
      [AGENTS]: CODEBASE_TEXT,
      [join(PROJECT, "api", "AGENTS.md")]: "a",
      [join(PROJECT, "api", "CLAUDE.md")]: "c",
      [join(PROJECT, "web", "CLAUDE.md")]: "c",
    });
    const text = projectAgentsText(fs, {
      projectDir: PROJECT,
      codebaseDir: CODEBASE,
      branch: "feat/x",
      repos: ["cli", "api", "web"],
      configRepos: CONFIG,
    });
    expect(text).toBe(
      [
        "# Agents",
        "",
        "Intro.",
        "",
        "## Codebase",
        "",
        "This folder is a crossrepo project for branch `feat/x`. `xr` writes this section, so do not edit it by hand.",
        "",
        "Each repo is a git worktree on this branch. Run `xr --help` to see all commands.",
        "",
        "Repos:",
        "",
        "- [`web`](web/CLAUDE.md)",
        "- [`api`](api/AGENTS.md) — The HTTP API",
        "- `cli`",
        "",
        "## Repos",
        "",
        "Pre.",
        "",
        "### API",
        "",
        "api text",
        "",
        "### web",
        "",
        "web text",
        "",
        "## Other",
        "",
        "other",
        "",
      ].join("\n"),
    );
  });

  test("a project repo not in the config comes last, in the given order, with no description", () => {
    const { fs } = fakeFs();
    const text = projectAgentsText(fs, {
      projectDir: PROJECT,
      codebaseDir: CODEBASE,
      branch: "main",
      repos: ["zed", "api", "alpha"],
      configRepos: CONFIG,
    });
    expect(text).toContain("- `api` — The HTTP API\n- `zed`\n- `alpha`\n");
  });

  test("no codebase file and no project file: only `## Codebase` and an empty `## Repos`", () => {
    const { fs } = fakeFs();
    const text = projectAgentsText(fs, {
      projectDir: PROJECT,
      codebaseDir: CODEBASE,
      branch: "main",
      repos: [],
      configRepos: [],
    });
    expect(text).toStartWith("## Codebase\n\n");
    expect(text).toEndWith("Repos:\n\n- none\n\n## Repos\n");
  });

  test("rewrite: user text in the two sections is replaced, other sections stay, `## Repos` comes from the codebase file", () => {
    const old =
      "# Mine\r\n\r\n## Codebase\r\n\r\nuser text\r\n\r\n## Repos\r\n\r\nuser repos\r\n\r\n## Notes\r\n\r\nkeep  me\r\n";
    const { fs } = fakeFs({
      [AGENTS]: CODEBASE_TEXT,
      [PROJECT_AGENTS]: old,
    });
    const text = projectAgentsText(fs, {
      projectDir: PROJECT,
      codebaseDir: CODEBASE,
      branch: "main",
      repos: ["docs"],
      configRepos: CONFIG,
    });
    expect(text).toStartWith("# Mine\r\n\r\n## Codebase\r\n");
    expect(text).toContain(
      "- `docs` — Docs\r\n\r\n## Repos\r\n\r\nPre.\r\n\r\n### docs\r\n\r\ndocs text\r\n\r\n## Notes\r\n\r\nkeep  me\r\n",
    );
    expect(text).not.toContain("user");
    expect(text.replaceAll("\r\n", "")).not.toContain("\n");
  });
});

/** A `tx` that runs each step and keeps its undo, so a test can run it. */
function fakeTx() {
  const undos: (() => void | Promise<void>)[] = [];
  const leftovers: Leftover[] = [];
  const tx: Tx = {
    signal: new AbortController().signal,
    step: async (_label, run, undo, manualCleanup) => {
      leftovers.push(manualCleanup);
      const result = await run(new AbortController().signal);
      undos.push(() => undo(result));
      return result;
    },
    finals: async () => {},
  };
  return { tx, undos, leftovers };
}

describe("writeAgentsStep", () => {
  test("writes the text; undo removes a file that it made", async () => {
    const { fs, files, writes, removes } = fakeFs();
    const { tx, undos, leftovers } = fakeTx();
    await writeAgentsStep(fs, tx, AGENTS, "new\n", "by hand");
    expect(files[AGENTS]).toBe("new\n");
    expect(leftovers).toEqual([
      { what: "AGENTS.md", path: AGENTS, command: `rm "${AGENTS}"` },
    ]);
    await undos[0]?.();
    expect(removes).toEqual([AGENTS]);
    expect(writes).toHaveLength(1);
  });

  test("undo writes the old text back to a file that existed", async () => {
    const { fs, files, removes } = fakeFs({ [AGENTS]: "old\n" });
    const { tx, undos, leftovers } = fakeTx();
    await writeAgentsStep(fs, tx, AGENTS, "new\n", "by hand");
    expect(files[AGENTS]).toBe("new\n");
    expect(leftovers[0]?.command).toBe("by hand");
    await undos[0]?.();
    expect(files[AGENTS]).toBe("old\n");
    expect(removes).toEqual([]);
  });

  test("does not write when the text is the same", async () => {
    const { fs, writes } = fakeFs({ [AGENTS]: "same\n" });
    const { tx } = fakeTx();
    await writeAgentsStep(fs, tx, AGENTS, "same\n", "by hand");
    expect(writes).toHaveLength(0);
  });

  test("passes the label `Write AGENTS.md`", async () => {
    const { fs } = fakeFs();
    const labels: string[] = [];
    const { tx } = fakeTx();
    const step = tx.step;
    tx.step = (label, ...rest) => {
      labels.push(label);
      return step(label, ...rest);
    };
    await writeAgentsStep(fs, tx, AGENTS, "x", "by hand");
    expect(labels).toEqual(["Write AGENTS.md"]);
  });
});
