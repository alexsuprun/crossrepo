import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, discover } from "../../../src/config/index.ts";
import { type Isolation, isolate, writeFile } from "../../helpers/isolate.ts";

let iso: Isolation;
let codebase: string;
let project: string;

beforeEach(() => {
  iso = isolate();
  codebase = join(iso.root, "shop");
  writeFile(join(codebase, ".crossrepo", "config.yaml"), "");
  project = join(iso.root, "work", "feat");
});

afterEach(() => {
  iso.restore();
});

function writeRecord(text: string) {
  writeFile(join(project, ".crossrepo", "project.yaml"), text);
}

/** The original error of a `broken-project` discovery. */
function discoverError(dir: string): ConfigError {
  const found = discover(dir);
  if (found.kind !== "broken-project") {
    throw new Error(`discover gave ${found.kind}, not broken-project`);
  }
  expect(found.dir).toBe(dir);
  expect(found.error).toBeInstanceOf(ConfigError);
  return found.error;
}

describe("discover", () => {
  test(".crossrepo/config.yaml or config.yml means a codebase", () => {
    expect(discover(codebase)).toEqual({
      kind: "codebase",
      dir: codebase,
      codebase,
    });
    const other = join(iso.root, "other");
    writeFile(join(other, ".crossrepo", "config.yml"), "");
    expect(discover(other).kind).toBe("codebase");
  });

  test("anything else is none, and a parent folder is never used", () => {
    const child = join(codebase, "api");
    mkdirSync(child);
    expect(discover(child)).toEqual({ kind: "none", dir: child });
    expect(discover(join(iso.root, "missing"))).toEqual({
      kind: "none",
      dir: join(iso.root, "missing"),
    });
  });

  test("a project record means a project, and its codebase key gives the codebase", () => {
    writeRecord(`codebase: ${JSON.stringify(codebase)}\nbranch: feat\n`);
    expect(discover(project)).toEqual({
      kind: "project",
      dir: project,
      codebase,
    });
  });

  test("a relative codebase in the record is relative to the project folder", () => {
    writeRecord("codebase: ../../shop\n");
    expect(discover(project)).toEqual({
      kind: "project",
      dir: project,
      codebase,
    });
  });

  test("a project whose codebase path does not exist is broken-project with the not-a-codebase error", () => {
    writeRecord(`codebase: ${JSON.stringify(join(iso.root, "gone"))}\n`);
    const error = discoverError(project);
    expect(error.kind).toBe("not-a-codebase");
    expect(error.message).toContain(join(iso.root, "gone"));
    expect(error.hint).toContain("--codebase-path <path>");
  });

  test("a project record without a codebase path or with invalid YAML is broken-project with the not-a-codebase error", () => {
    for (const text of [
      "branch: x\n",
      "codebase: 3\n",
      "- a\n",
      "a: [\n",
      "",
    ]) {
      writeRecord(text);
      const error = discoverError(project);
      expect(error.kind).toBe("not-a-codebase");
      expect(error.message).toContain(
        join(project, ".crossrepo", "project.yaml"),
      );
    }
  });

  test("a record that cannot be read is still thrown as it is", () => {
    mkdirSync(join(project, ".crossrepo", "project.yaml"), { recursive: true });
    expect(() => discover(project)).toThrow();
  });
});
