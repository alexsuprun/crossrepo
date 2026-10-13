import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../../src/config/index.ts";
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

function errno(code: string): Error {
  return Object.assign(new Error(`${code}: rename`), { code });
}

describe("writeFileAtomic", () => {
  test("creates a missing file and leaves no temp file", () => {
    const path = join(dir, "AGENTS.md");
    writeFileAtomic(path, "hello\n");
    expect(readFileSync(path, "utf8")).toBe("hello\n");
    expect(readdirSync(dir)).toEqual(["AGENTS.md"]);
  });

  // Windows chmod only toggles read-only, so the mode check cannot hold there.
  test.skipIf(process.platform === "win32")(
    "replaces an existing file and keeps its mode",
    () => {
      const path = writeFile(join(dir, "AGENTS.md"), "old");
      fs.chmodSync(path, 0o640);
      writeFileAtomic(path, "new");
      expect(readFileSync(path, "utf8")).toBe("new");
      expect(statSync(path).mode & 0o777).toBe(0o640);
    },
  );

  test("a symlink: the real file is written and the link stays", () => {
    const real = writeFile(join(iso.root, "meta", "AGENTS.md"), "old");
    const link = join(dir, "AGENTS.md");
    symlinkSync(real, link);
    writeFileAtomic(link, "new");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe("new");
    expect(readdirSync(join(iso.root, "meta"))).toEqual(["AGENTS.md"]);
  });

  test("a dangling symlink: the link target is created and the link stays", () => {
    mkdirSync(join(iso.root, "meta"));
    const real = join(iso.root, "meta", "AGENTS.md");
    const link = join(dir, "AGENTS.md");
    symlinkSync(real, link);
    writeFileAtomic(link, "new");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe("new");
  });

  test("a symlinked parent folder: the file is written in the real folder", () => {
    const realDir = join(iso.root, "real");
    mkdirSync(realDir);
    const linkDir = join(iso.root, "linked");
    symlinkSync(realDir, linkDir);
    writeFileAtomic(join(linkDir, "AGENTS.md"), "x");
    expect(readFileSync(join(realDir, "AGENTS.md"), "utf8")).toBe("x");
    expect(lstatSync(linkDir).isSymbolicLink()).toBe(true);
  });

  test.each(["EPERM", "EACCES", "EBUSY"])(
    "on Windows a %s rename is retried until it works",
    (code) => {
      const path = join(dir, "AGENTS.md");
      const rename = fs.renameSync;
      let calls = 0;
      const spy = spyOn(fs, "renameSync").mockImplementation((from, to) => {
        calls += 1;
        if (calls < 3) throw errno(code);
        rename(from, to);
      });
      try {
        writeFileAtomic(path, "x", "win32");
      } finally {
        spy.mockRestore();
      }
      expect(calls).toBe(3);
      expect(readFileSync(path, "utf8")).toBe("x");
    },
  );

  test("on Windows a rename that stays busy gives up with a busy error that keeps the code, and removes the temp file", () => {
    const codes = ["EPERM", "EACCES", "EBUSY"];
    const path = join(dir, "AGENTS.md");
    let calls = 0;
    const spy = spyOn(fs, "renameSync").mockImplementation(() => {
      calls += 1;
      throw errno(codes[(calls - 1) % codes.length] as string);
    });
    let thrown: unknown;
    try {
      writeFileAtomic(path, "x", "win32");
    } catch (error) {
      thrown = error;
    } finally {
      spy.mockRestore();
    }
    expect(calls).toBeGreaterThan(codes.length);
    expect(thrown).toMatchObject({ busy: true, path });
    expect(codes).toContain((thrown as { code: string }).code);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("off Windows a failed rename is not retried", () => {
    let calls = 0;
    const spy = spyOn(fs, "renameSync").mockImplementation(() => {
      calls += 1;
      throw errno("EBUSY");
    });
    let thrown: unknown;
    try {
      writeFileAtomic(join(dir, "AGENTS.md"), "x", "darwin");
    } catch (error) {
      thrown = error;
    } finally {
      spy.mockRestore();
    }
    expect(calls).toBe(1);
    expect(thrown).toMatchObject({ code: "EBUSY" });
    expect((thrown as { busy?: boolean }).busy).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a temp file write that fails after creating the file is removed", () => {
    const write = fs.writeFileSync;
    const spy = spyOn(fs, "writeFileSync").mockImplementation(
      (file, _data, options) => {
        write(file, "", options as fs.WriteFileOptions);
        throw errno("ENOSPC");
      },
    );
    try {
      expect(() => writeFileAtomic(join(dir, "AGENTS.md"), "x")).toThrow(
        "ENOSPC",
      );
    } finally {
      spy.mockRestore();
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a temp file that already exists (EEXIST) is not removed", () => {
    const temps: string[] = [];
    const write = fs.writeFileSync;
    const again = spyOn(fs, "writeFileSync").mockImplementation((file) => {
      write(file, "theirs");
      temps.push(String(file));
      throw errno("EEXIST");
    });
    try {
      expect(() => writeFileAtomic(join(dir, "AGENTS.md"), "x")).toThrow(
        "EEXIST",
      );
    } finally {
      again.mockRestore();
    }
    expect(temps).toHaveLength(1);
    expect(readFileSync(temps[0] as string, "utf8")).toBe("theirs");
  });

  test("on Windows another error code is not retried", () => {
    let calls = 0;
    const spy = spyOn(fs, "renameSync").mockImplementation(() => {
      calls += 1;
      throw errno("ENOSPC");
    });
    try {
      expect(() =>
        writeFileAtomic(join(dir, "AGENTS.md"), "x", "win32"),
      ).toThrow("ENOSPC");
    } finally {
      spy.mockRestore();
    }
    expect(calls).toBe(1);
  });
});
