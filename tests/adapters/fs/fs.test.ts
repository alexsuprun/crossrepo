import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { lstatSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { createFs } from "../../../src/adapters/fs/index.ts";
import { XrError } from "../../../src/errors/index.ts";
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
