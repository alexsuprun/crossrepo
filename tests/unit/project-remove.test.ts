import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createFs } from "../../src/adapters/fs/index.ts";
import { driftFolders } from "../../src/services/project-remove.ts";
import { type Isolation, isolate, writeFile } from "../helpers/isolate.ts";

let iso: Isolation;
let project: string;

beforeEach(() => {
  iso = isolate();
  project = join(iso.root, "feat");
  mkdirSync(project);
});

afterEach(() => {
  iso.restore();
});

describe("driftFolders", () => {
  test("gives the folders that are not record repos, in name order", () => {
    for (const name of ["api", "tmp", "build"]) {
      mkdirSync(join(project, name));
    }
    expect(driftFolders(createFs(), project, ["api", "web"])).toEqual([
      "build",
      "tmp",
    ]);
  });

  test("dot folders and files do not count", () => {
    mkdirSync(join(project, ".idea"));
    mkdirSync(join(project, ".crossrepo"));
    writeFile(join(project, "AGENTS.md"), "x");
    mkdirSync(join(project, "api"));
    expect(driftFolders(createFs(), project, ["api"])).toEqual([]);
  });
});
