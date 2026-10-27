import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** A temp folder that stands in for the home folder and the global git config. */
export interface Isolation {
  /** The temp folder, with symlinks resolved. Put test codebases here. */
  root: string;
  /** `HOME` and `USERPROFILE` point here; `.gitconfig` here holds the test identity. */
  home: string;
  /** Puts the env back and deletes `root`. */
  restore(): void;
}

const ENV_NAMES = [
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
] as const;

/**
 * Points `HOME` and `USERPROFILE` at a new temp folder whose `.gitconfig` has
 * only a test identity, `XDG_CONFIG_HOME` at an empty folder, and sets
 * `GIT_CONFIG_NOSYSTEM=1`. It unsets `GIT_CONFIG_GLOBAL`, which needs git 2.32
 * while the floor is 2.27. Every adapter, command and smoke test that touches
 * files or git uses it (AD-13).
 */
export function isolate(): Isolation {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "xr-test-")));
  const home = join(root, "home");
  mkdirSync(home);
  const xdg = join(root, "xdg-config");
  mkdirSync(xdg);
  writeFileSync(
    join(home, ".gitconfig"),
    "[user]\n\tname = xr test\n\temail = xr-test@example.com\n",
  );
  const saved = Object.fromEntries(
    ENV_NAMES.map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: xdg,
    GIT_CONFIG_NOSYSTEM: "1",
  });
  delete process.env.GIT_CONFIG_GLOBAL;
  return {
    root,
    home,
    restore() {
      for (const name of ENV_NAMES) {
        const value = saved[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Writes `text` to `path`, making its folders first. */
export function writeFile(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}
