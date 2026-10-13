import type { LiveEvent, Report } from "./report.ts";

export type DiscoveryKind = "none" | "codebase" | "project";

/** What the folder from `--codebase-path` or the current folder is (AD-9). */
export type Discovery =
  | { kind: "none"; dir: string }
  | { kind: "codebase"; dir: string; codebase: string }
  | { kind: "project"; dir: string; codebase: string };

export type ConfigSource = { kind: "file"; path: string } | { kind: "default" };

/** One merged leaf key in dotted form. A hook list is one entry. */
export interface ConfigEntry {
  key: string;
  value: string | string[];
  source: ConfigSource;
  /** Only on `projects-dir`: the absolute path. */
  resolved?: string;
}

/** The merged config as commands see it. */
export interface ConfigView {
  codebase: string;
  entries: ConfigEntry[];
  projectsDir: { value: string; source: ConfigSource; resolved: string };
}

/** The one plain object `cli` builds for each run (AD-1). Commands do all I/O through it. */
export interface Ctx {
  out: { emit(event: LiveEvent): void };
  /** Text file I/O. `readText` gives `undefined` for a missing file; `writeText` is atomic. */
  fs: {
    readText(path: string): string | undefined;
    writeText(path: string, text: string): void;
  };
  config: ConfigView;
  discovery: Discovery;
  /** stdin and stdout are a TTY, and neither `--json` nor `--no-interactive` is given. */
  interactive: boolean;
}

/** One `xr` command. `cli` checks the folder kind before `run`. */
export interface CommandUnit {
  accepts: readonly DiscoveryKind[];
  run(ctx: Ctx): Report;
}
