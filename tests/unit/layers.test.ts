import { describe, expect, test } from "bun:test";
import {
  checkImports,
  readSourceFiles,
  type SourceFile,
} from "../helpers/layers.ts";

function check(files: Record<string, string>) {
  const list: SourceFile[] = Object.entries(files).map(([path, source]) => ({
    path,
    source,
  }));
  return checkImports(list);
}

function rules(files: Record<string, string>): string[] {
  return check(files).map((violation) => violation.rule);
}

describe("real src/", () => {
  test("has no import against the layer rules", () => {
    const files = readSourceFiles(new URL("../../src/", import.meta.url));
    expect(files.length).toBeGreaterThan(0);
    expect(checkImports(files)).toEqual([]);
  });
});

describe("checkImports on fixtures", () => {
  test("reports domain importing an adapter", () => {
    const violations = check({
      "src/domain/hook-env.ts":
        'import { git } from "../adapters/git/index.ts";',
    });
    expect(violations).toEqual([
      {
        file: "src/domain/hook-env.ts",
        specifier: "../adapters/git/index.ts",
        rule: "domain may not import adapters",
      },
    ]);
  });

  test("reports one command importing another", () => {
    expect(
      rules({
        "src/commands/project/create.ts":
          'import { run } from "../codebase/init.ts";',
      }),
    ).toEqual(["command project/create may not import command codebase/init"]);
  });

  test("reports a command importing another command in the same group", () => {
    expect(
      rules({
        "src/commands/project/create/index.ts":
          'export { x } from "../../project/remove.ts";',
      }),
    ).toEqual(["command project/create may not import command project/remove"]);
  });

  test("allows files inside one command to import each other", () => {
    expect(
      rules({
        "src/commands/project/create/index.ts": 'import "./steps.ts";',
      }),
    ).toEqual([]);
  });

  test("allows every arrow of the layer table", () => {
    expect(
      rules({
        "src/cli/index.ts": [
          'import "../commands/doctor/doctor.ts";',
          'import "../adapters/git/index.ts";',
          'import "../config/index.ts";',
          'import "../output/index.ts";',
          'import "../errors/index.ts";',
          'import { Command } from "commander";',
        ].join("\n"),
        "src/commands/config/show.ts": [
          'import "../../services/projects.ts";',
          'import "../../runners/transaction.ts";',
          'import "../../domain/project.ts";',
          'import "../../errors/index.ts";',
        ].join("\n"),
        "src/services/worktrees.ts": [
          'import "./projects.ts";',
          'import "../domain/project.ts";',
          'import "../adapters/git/index.ts";',
          'import "../errors/index.ts";',
        ].join("\n"),
        "src/runners/per-repo.ts": [
          'import "./transaction.ts";',
          'import "../adapters/lock/index.ts";',
          'import "../errors/index.ts";',
        ].join("\n"),
        "src/domain/project.ts": [
          'import "./hook-env.ts";',
          'import "../errors/index.ts";',
          'import { parse } from "yaml";',
        ].join("\n"),
        "src/adapters/fs/index.ts": [
          'import { writeFileAtomic } from "../../config/index.ts";',
          'import "../../errors/index.ts";',
          'import { readFile } from "node:fs/promises";',
          'import { spawn } from "node:child_process";',
        ].join("\n"),
        "src/config/index.ts": 'import { rename } from "node:fs/promises";',
        "src/output/index.ts": 'import "./tones.ts";',
        "src/errors/index.ts": "export const x = 1;",
      }),
    ).toEqual([]);
  });

  test("reports arrows that are not in the layer table", () => {
    expect(
      rules({
        "src/cli/a.ts": 'import "../services/projects.ts";',
        "src/commands/doctor/doctor.ts": 'import "../../config/index.ts";',
        "src/services/a.ts": 'import "../commands/doctor/doctor.ts";',
        "src/runners/a.ts": 'import "../domain/project.ts";',
        "src/adapters/git/a.ts": 'import "../../output/index.ts";',
        "src/config/a.ts": 'import "../errors/index.ts";',
        "src/output/a.ts": 'import "../errors/index.ts";',
        "src/errors/a.ts": 'import "../domain/project.ts";',
      }),
    ).toEqual([
      "cli may not import services",
      "commands may not import config",
      "services may not import commands",
      "runners may not import domain",
      "adapters may not import output",
      "config may not import errors",
      "output may not import errors",
      "errors may not import domain",
    ]);
  });

  test("allows adapters to import only writeFileAtomic from config", () => {
    expect(
      rules({
        "src/adapters/fs/a.ts":
          'import { loadConfig } from "../../config/index.ts";',
        "src/adapters/fs/b.ts":
          'import { writeFileAtomic, loadConfig } from "../../config/index.ts";',
        "src/adapters/fs/c.ts": 'import "../../config/index.ts";',
        "src/adapters/fs/d.ts":
          'import type { writeFileAtomic } from "../../config/index.ts";',
        "src/adapters/fs/e.ts":
          'import { writeFileAtomic as write } from "../../config/index.ts";',
        "src/adapters/fs/f.ts":
          'import { type writeFileAtomic as write } from "../../config/index.ts";',
      }),
    ).toEqual([
      "adapters may import only writeFileAtomic from config",
      "adapters may import only writeFileAtomic from config",
      "adapters may import only writeFileAtomic from config",
    ]);
  });

  test("allows node:fs and node:child_process only in adapters, config and output", () => {
    expect(
      rules({
        "src/domain/a.ts": 'import { readFileSync } from "node:fs";',
        "src/services/a.ts": 'import { readFile } from "node:fs/promises";',
        "src/commands/codebase/clone.ts":
          'import { spawn } from "node:child_process";',
        "src/output/a.ts": 'import { writeSync } from "node:fs";',
        "src/domain/b.ts": 'import { join } from "node:path";',
      }),
    ).toEqual([
      "domain may not import node:fs",
      "services may not import node:fs/promises",
      "commands may not import node:child_process",
    ]);
  });

  test("allows @clack/prompts only in src/adapters/prompt, never spinner, tasks or block", () => {
    expect(
      rules({
        "src/adapters/prompt/index.ts":
          'import { isCancel, select } from "@clack/prompts";',
        "src/adapters/prompt/a.ts": 'import { spinner } from "@clack/prompts";',
        "src/adapters/prompt/b.ts":
          'import { select, tasks as run } from "@clack/prompts";',
        "src/adapters/prompt/c.ts": 'import * as clack from "@clack/prompts";',
        "src/adapters/prompt/d.ts": 'export { block } from "@clack/prompts";',
        "src/adapters/git/a.ts": 'import { select } from "@clack/prompts";',
        "src/cli/a.ts": 'import { select } from "@clack/core";',
      }),
    ).toEqual([
      "@clack/prompts may not be used for spinner, tasks or block",
      "@clack/prompts may not be used for spinner, tasks or block",
      "@clack/prompts may not be used for spinner, tasks or block",
      "@clack/prompts may not be used for spinner, tasks or block",
      "only src/adapters/prompt may import @clack/prompts",
      "only src/adapters/prompt may import @clack/core",
    ]);
  });

  test("sees type imports, re-exports and dynamic imports", () => {
    expect(
      rules({
        "src/domain/a.ts": [
          'import type { Git } from "../adapters/git/index.ts";',
          'export * from "../adapters/fs/index.ts";',
          'const m = await import("../adapters/lock/index.ts");',
        ].join("\n"),
      }),
    ).toEqual([
      "domain may not import adapters",
      "domain may not import adapters",
      "domain may not import adapters",
    ]);
  });

  test("reports a folder named like an Object prototype key", () => {
    expect(
      rules({
        "src/toString/a.ts": "export const x = 1;",
        "src/domain/a.ts": 'import "../constructor/x.ts";',
      }),
    ).toEqual([
      "src/toString is not a layer folder",
      "domain may not import constructor",
    ]);
  });

  test("reports files outside the layer folders and imports leaving src/", () => {
    expect(
      rules({
        "src/misc/a.ts": "export const x = 1;",
        "src/domain/a.ts": 'import "../../tests/helpers/layers.ts";',
      }),
    ).toEqual([
      "src/misc is not a layer folder",
      "domain may not import files outside src/",
    ]);
  });
});
