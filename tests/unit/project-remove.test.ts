import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createFs } from "../../src/adapters/fs/index.ts";
import {
  driftFolders,
  processesInWorktrees,
} from "../../src/services/project-remove.ts";
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

describe("processesInWorktrees", () => {
  const root = join("/", "work", "shop", ".projects", "feat");
  const api = join(root, "api");
  const web = join(root, "web");
  const proc = (pid: number, ppid: number, cwd: string, command = "node") => ({
    pid,
    ppid,
    command,
    cwd,
  });

  test("keeps a process in a worktree folder or below it", () => {
    const list = [proc(10, 1, api), proc(11, 1, join(web, "src", "app"))];
    expect(processesInWorktrees(list, 99, [api, web])).toEqual(list);
  });

  test("drops processes at the project root and outside", () => {
    const list = [proc(10, 1, root), proc(11, 1, join("/", "home", "me"))];
    expect(processesInWorktrees(list, 99, [api, web])).toEqual([]);
  });

  test("drops a sibling folder whose name starts with the worktree name", () => {
    const list = [proc(10, 1, `${api}-old`), proc(11, 1, `${web}2`)];
    expect(processesInWorktrees(list, 99, [api, web])).toEqual([]);
  });

  test("drops xr itself and its ancestor chain, keeps other processes", () => {
    const list = [
      proc(1, 0, "/", "launchd"),
      proc(20, 1, api, "zsh"),
      proc(21, 20, api, "bunx"),
      proc(22, 21, api, "xr"),
      proc(30, 20, api, "vite"),
    ];
    expect(processesInWorktrees(list, 22, [api])).toEqual([
      proc(30, 20, api, "vite"),
    ]);
  });

  test("an ancestor chain with a loop ends", () => {
    const list = [proc(5, 6, api), proc(6, 5, api), proc(7, 1, api)];
    expect(processesInWorktrees(list, 5, [api])).toEqual([proc(7, 1, api)]);
  });

  test("xr as pid 1 still drops itself", () => {
    const list = [proc(1, 0, api, "xr"), proc(10, 1, api)];
    expect(processesInWorktrees(list, 1, [api])).toEqual([proc(10, 1, api)]);
  });

  test("xr not in the list: nothing is dropped as an ancestor", () => {
    const list = [proc(10, 1, api)];
    expect(processesInWorktrees(list, 99, [api])).toEqual(list);
  });
});
