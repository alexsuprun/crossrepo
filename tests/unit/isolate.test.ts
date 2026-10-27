import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../helpers/git.ts";
import { type Isolation, isolate } from "../helpers/isolate.ts";

let iso: Isolation | undefined;

afterEach(() => {
  iso?.restore();
  iso = undefined;
});

// GIT_CONFIG_GLOBAL needs git 2.32; the floor is 2.27, so the identity goes to $HOME/.gitconfig.
describe("isolate", () => {
  test("writes the test identity to <home>/.gitconfig", () => {
    iso = isolate();
    expect(readFileSync(join(iso.home, ".gitconfig"), "utf8")).toBe(
      "[user]\n\tname = xr test\n\temail = xr-test@example.com\n",
    );
  });

  test("sets HOME, USERPROFILE and GIT_CONFIG_NOSYSTEM", () => {
    iso = isolate();
    expect(process.env.HOME).toBe(iso.home);
    expect(process.env.USERPROFILE).toBe(iso.home);
    expect(process.env.GIT_CONFIG_NOSYSTEM).toBe("1");
  });

  test("unsets GIT_CONFIG_GLOBAL, even when it was set, and puts it back on restore", () => {
    const before = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = "/somewhere/gitconfig";
    try {
      const local = isolate();
      expect(process.env.GIT_CONFIG_GLOBAL).toBeUndefined();
      local.restore();
      expect(process.env.GIT_CONFIG_GLOBAL).toBe("/somewhere/gitconfig");
    } finally {
      if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = before;
    }
  });

  // git also reads $XDG_CONFIG_HOME/git/config as a global config.
  test("sets XDG_CONFIG_HOME to an empty folder under root", () => {
    iso = isolate();
    const xdg = process.env.XDG_CONFIG_HOME ?? "";
    expect(xdg.startsWith(iso.root)).toBe(true);
    expect(xdg.startsWith(iso.home)).toBe(false);
    expect(existsSync(xdg)).toBe(true);
    expect(readdirSync(xdg)).toEqual([]);
  });

  test("git reads the test identity", () => {
    iso = isolate();
    expect(git(iso.root, "config", "--global", "user.name")).toBe("xr test\n");
  });

  test("restore puts the env back and deletes root", () => {
    const before = {
      HOME: process.env.HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    };
    const local = isolate();
    local.restore();
    expect({
      HOME: process.env.HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    }).toEqual(before);
    expect(existsSync(local.root)).toBe(false);
  });
});
