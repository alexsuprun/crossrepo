import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { createFs } from "../../../src/adapters/fs/index.ts";
import { XrError } from "../../../src/errors/index.ts";
import { git, makeRepos } from "../../helpers/git.ts";
import { type Isolation, isolate, writeFile } from "../../helpers/isolate.ts";

let iso: Isolation;
let dir: string;

beforeEach(() => {
  iso = isolate();
  dir = join(iso.root, "shop");
  mkdirSync(dir);
});

afterEach(() => {
  iso.restore();
});

describe("createFs", () => {
  test("readText gives the text, or undefined when the file is missing", () => {
    const path = writeFile(join(dir, "AGENTS.md"), "a\r\nb\n");
    expect(createFs().readText(path)).toBe("a\r\nb\n");
    expect(createFs().readText(join(dir, "missing.md"))).toBeUndefined();
  });

  test("readText still fails on other errors", () => {
    expect(() => createFs().readText(dir)).toThrow();
  });

  test("writeText creates a file and writes through a symlink", () => {
    const real = writeFile(join(iso.root, "meta", "AGENTS.md"), "old");
    const link = join(dir, "AGENTS.md");
    symlinkSync(real, link);
    createFs().writeText(link, "new");
    expect(readFileSync(real, "utf8")).toBe("new");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);

    const created = join(dir, "NEW.md");
    createFs().writeText(created, "x");
    expect(readFileSync(created, "utf8")).toBe("x");
  });

  test("on Windows a rename that stays busy (EPERM, EACCES or EBUSY) is retried, then fails with file-busy", () => {
    const codes = ["EPERM", "EACCES", "EBUSY"];
    const path = join(dir, "AGENTS.md");
    let calls = 0;
    const spy = spyOn(fs, "renameSync").mockImplementation(() => {
      const code = codes[calls % codes.length] as string;
      calls += 1;
      throw Object.assign(new Error(`${code}: rename`), { code });
    });
    let thrown: unknown;
    try {
      createFs("win32").writeText(path, "x");
    } catch (error) {
      thrown = error;
    } finally {
      spy.mockRestore();
    }
    expect(calls).toBeGreaterThan(codes.length);
    expect(thrown).toBeInstanceOf(XrError);
    expect(thrown).toMatchObject({
      code: "file-busy",
      hint: `Close programs that use \`${path}\`, then run the command again.`,
    });
  });

  test("another write error is not mapped to file-busy", () => {
    const spy = spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("EACCES: rename"), { code: "EACCES" });
    });
    let thrown: unknown;
    try {
      createFs("darwin").writeText(join(dir, "AGENTS.md"), "x");
    } catch (error) {
      thrown = error;
    } finally {
      spy.mockRestore();
    }
    expect(thrown).not.toBeInstanceOf(XrError);
    expect(thrown).toMatchObject({ code: "EACCES" });
  });
});

describe("createFs folders", () => {
  test("mkdir makes one folder and fails when it exists or its parent is missing", () => {
    const path = join(dir, ".crossrepo");
    createFs().mkdir(path);
    expect(lstatSync(path).isDirectory()).toBe(true);
    expect(() => createFs().mkdir(path)).toThrow();
    expect(() => createFs().mkdir(join(dir, "a", "b"))).toThrow();
  });

  test("remove deletes a file or a whole folder, and a missing path is fine", () => {
    const file = writeFile(join(dir, "AGENTS.md"), "x");
    const folder = join(dir, ".crossrepo");
    writeFile(join(folder, "config.yaml"), "x");
    createFs().remove(file);
    createFs().remove(folder);
    createFs().remove(join(dir, "missing"));
    expect(existsSync(file)).toBe(false);
    expect(existsSync(folder)).toBe(false);
  });

  test("listDirs gives the child folder names sorted, without files", () => {
    for (const name of ["web", "api", ".hidden", "Zed"]) {
      mkdirSync(join(dir, name));
    }
    writeFile(join(dir, "README.md"), "");
    expect(createFs().listDirs(dir)).toEqual([".hidden", "Zed", "api", "web"]);
  });

  test.skipIf(process.platform === "win32")(
    "listDirs leaves out a symlink to a folder",
    () => {
      mkdirSync(join(dir, "api"));
      symlinkSync(join(dir, "api"), join(dir, "link"));
      expect(createFs().listDirs(dir)).toEqual(["api"]);
    },
  );

  test("exists sees files and folders, and a .git file", () => {
    writeFile(join(dir, "api", ".git"), "gitdir: ../x\n");
    expect(createFs().exists(join(dir, "api", ".git"))).toBe(true);
    expect(createFs().exists(join(dir, "api"))).toBe(true);
    expect(createFs().exists(join(dir, "web"))).toBe(false);
  });
});

describe("createFs realpath", () => {
  test("gives the absolute path with . and .. resolved", () => {
    mkdirSync(join(dir, "api"));
    expect(createFs().realpath(join(dir, "api", "..", "api", "."))).toBe(
      join(dir, "api"),
    );
  });

  test.skipIf(process.platform === "win32")(
    "follows a symlink to its target",
    () => {
      const real = join(iso.root, "elsewhere");
      mkdirSync(real);
      symlinkSync(real, join(dir, "link"));
      expect(createFs().realpath(join(dir, "link"))).toBe(real);
    },
  );

  test("a missing path throws", () => {
    expect(() => createFs().realpath(join(dir, "missing"))).toThrow();
  });
});

describe("createFs remove of read-only files", () => {
  test.each(Array.from({ length: 20 }, (_, i) => i))(
    "DIAG %i: deletes a git repo with its read-only object files (runs on Windows CI)",
    () => {
      makeRepos(dir, { api: {} });
      const repo = join(dir, "api");
      writeFile(join(repo, "a.txt"), "x");
      git(repo, "add", "a.txt");
      git(repo, "commit", "--quiet", "-m", "a");
      chmodSync(join(repo, "a.txt"), 0o444);
      createFs().remove(repo);
      if (existsSync(repo)) {
        const left = (fs.readdirSync(repo, { recursive: true }) as string[])
          .map((name) => {
            const stats = lstatSync(join(repo, name));
            return `${stats.isDirectory() ? "d" : "f"} ${(stats.mode & 0o777).toString(8)} ${stats.mtimeMs} ${name}`;
          })
          .sort();
        const after = spawnSync("ps", ["-Ao", "pid,ppid,etime,command"], {
          encoding: "utf8",
        }).stdout;
        const gitLines = (text: string) =>
          text.split("\n").filter((line) => /git/.test(line));
        console.error(
          [
            `DIAG left in ${repo} (now ${Date.now()}):`,
            ...left,
            "DIAG git processes after remove:",
            ...gitLines(after),
            "DIAG git config:",
            spawnSync("git", ["config", "--show-origin", "--list"], {
              encoding: "utf8",
            }).stdout,
          ].join("\n"),
        );
      }
      expect(existsSync(repo)).toBe(false);
    },
  );

  test("makes the files writable and tries again when the delete fails with EPERM or EACCES", () => {
    const folder = join(dir, "api");
    const file = writeFile(join(folder, "objects", "ab"), "x");
    chmodSync(file, 0o444);
    for (const code of ["EPERM", "EACCES"]) {
      const real = fs.rmSync;
      let calls = 0;
      const spy = spyOn(fs, "rmSync").mockImplementation((path, options) => {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new Error(`${code}: rm`), { code });
        }
        real(path, options);
      });
      try {
        createFs().remove(folder);
      } finally {
        spy.mockRestore();
      }
      expect(calls).toBe(2);
      expect(existsSync(folder)).toBe(false);
      writeFile(file, "x");
      chmodSync(file, 0o444);
    }
  });

  test("another delete error is thrown as it is", () => {
    const spy = spyOn(fs, "rmSync").mockImplementation(() => {
      throw Object.assign(new Error("EIO: rm"), { code: "EIO" });
    });
    try {
      expect(() => createFs().remove(join(dir, "x"))).toThrow("EIO");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("createFs stat", () => {
  test("gives dev and ino as bigint, the same for a folder and a path to it", () => {
    mkdirSync(join(dir, "api"));
    const a = createFs().stat(join(dir, "api"));
    const b = createFs().stat(join(dir, "api", "..", "api"));
    expect(typeof a?.dev).toBe("bigint");
    expect(typeof a?.ino).toBe("bigint");
    expect(b).toEqual(a as { dev: bigint; ino: bigint });
    expect(createFs().stat(dir)).not.toEqual(a as { dev: bigint; ino: bigint });
  });

  test.skipIf(process.platform === "win32")("follows a symlink", () => {
    mkdirSync(join(dir, "api"));
    symlinkSync(join(dir, "api"), join(dir, "link"));
    expect(createFs().stat(join(dir, "link"))).toEqual(
      createFs().stat(join(dir, "api")) as { dev: bigint; ino: bigint },
    );
  });

  test("a missing path gives undefined", () => {
    expect(createFs().stat(join(dir, "missing"))).toBeUndefined();
  });
});
