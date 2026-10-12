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
  /** `HOME` and `USERPROFILE` point here. */
  home: string;
  /** Puts the env back and deletes `root`. */
  restore(): void;
}

const ENV_NAMES = [
  "HOME",
  "USERPROFILE",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
] as const;

/**
 * Sets `HOME`, `USERPROFILE`, `GIT_CONFIG_GLOBAL` (an empty config with a test
 * identity) and `GIT_CONFIG_NOSYSTEM=1` to a new temp folder. Every adapter,
 * command and smoke test that touches files or git uses it (AD-13).
 */
export function isolate(): Isolation {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "xr-test-")));
  const home = join(root, "home");
  mkdirSync(home);
  const gitConfig = join(root, "gitconfig");
  writeFileSync(
    gitConfig,
    "[user]\n\tname = xr test\n\temail = xr-test@example.com\n",
  );
  const saved = Object.fromEntries(
    ENV_NAMES.map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
  });
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
