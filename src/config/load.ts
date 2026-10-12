import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { closest } from "fastest-levenshtein";
import { parseDocument } from "yaml";
import { ConfigError } from "./errors.ts";
import {
  type ConfigValues,
  fileSchema,
  knownKeys,
  strictFileSchema,
} from "./schema.ts";

export const DEFAULT_PROJECTS_DIR = ".projects";

export type ConfigSource = { kind: "file"; path: string } | { kind: "default" };

/** One leaf key in dotted form. A hook list is one entry. */
export interface ConfigEntry {
  key: string;
  value: string | string[];
  source: ConfigSource;
  /** Only on `projects-dir`: the absolute path. */
  resolved?: string;
}

export interface UnknownKey {
  key: string;
  files: string[];
  suggestion: string;
}

export interface LoadedConfig {
  codebase: string;
  values: ConfigValues;
  entries: ConfigEntry[];
  projectsDir: { value: string; source: ConfigSource; resolved: string };
  unknownKeys: UnknownKey[];
}

export interface LoadConfigOptions {
  home: string;
  codebase: string;
}

type Tree = { [key: string]: Tree | string | string[] };

/**
 * Reads the user, codebase and local levels, in that order. A later level wins,
 * maps merge key by key and lists are replaced whole (D27, D28). Throws `ConfigError`.
 */
export function loadConfig({
  home,
  codebase,
}: LoadConfigOptions): LoadedConfig {
  const levels = [
    join(home, ".crossrepo", "config"),
    join(codebase, ".crossrepo", "config"),
    join(codebase, ".crossrepo", "config.local"),
  ];
  let merged: Tree = {};
  const sources = new Map<string, string>();
  const unknown = new Map<string, UnknownKey>();
  for (const base of levels) {
    const file = pickFile(base);
    if (file === undefined) continue;
    const tree = readFile(file, unknown);
    merged = mergeTrees(merged, tree);
    for (const [key] of leaves(tree)) sources.set(key, file);
  }
  const values = fileSchema.parse(merged) as ConfigValues;
  const setDir = values["projects-dir"];
  const projectsDir = {
    value: setDir ?? DEFAULT_PROJECTS_DIR,
    source: sourceOf(sources, "projects-dir"),
    resolved: resolveProjectsDir(
      setDir ?? DEFAULT_PROJECTS_DIR,
      codebase,
      home,
    ),
  };
  const rest = leaves(values as Tree).filter(
    ([key]) => key !== "name" && key !== "projects-dir",
  );
  const entries: ConfigEntry[] = [
    ...(values.name === undefined
      ? []
      : [
          {
            key: "name",
            value: values.name,
            source: sourceOf(sources, "name"),
          },
        ]),
    { key: "projects-dir", ...projectsDir },
    ...rest.map(([key, value]) => ({
      key,
      value,
      source: sourceOf(sources, key),
    })),
  ];
  return {
    codebase,
    values,
    entries,
    projectsDir,
    unknownKeys: [...unknown.values()],
  };
}

/** The `.yaml` or `.yml` file at `base`, or `undefined` when there is none. */
function pickFile(base: string): string | undefined {
  const found = [`${base}.yaml`, `${base}.yml`].filter((file) =>
    existsSync(file),
  );
  if (found.length > 1) {
    throw new ConfigError({
      kind: "conflict",
      message: `Two config files at one level: ${found[0]} and ${found[1]}.`,
      hint: "Keep one of the two files and delete the other.",
    });
  }
  return found[0];
}

function readFile(file: string, unknown: Map<string, UnknownKey>): Tree {
  const raw = parseYaml(file) ?? {};
  const strict = strictFileSchema.safeParse(raw);
  for (const issue of strict.error?.issues ?? []) {
    if (issue.code !== "unrecognized_keys") continue;
    for (const key of issue.keys) {
      const dotted = [...issue.path, key].join(".");
      const known = unknown.get(dotted);
      if (known) {
        known.files.push(file);
        continue;
      }
      const suggestion = [...issue.path, closest(key, knownKeys(issue.path))];
      unknown.set(dotted, {
        key: dotted,
        files: [file],
        suggestion: suggestion.join("."),
      });
    }
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const key = issue?.path.join(".") || "the top level";
    const reason = issue?.message.replace(/^Invalid input: /, "");
    throw new ConfigError({
      kind: "invalid",
      message: `Invalid config in ${file}: \`${key}\`: ${reason}.`,
      hint: `Fix \`${key}\` in ${file}.`,
    });
  }
  return dropNulls(parsed.data);
}

function parseYaml(file: string): unknown {
  const doc = parseDocument(readFileSync(file, "utf8"));
  const [error] = doc.errors;
  if (error) {
    throw new ConfigError({
      kind: "invalid",
      message: `Invalid YAML in ${file}: ${error.message}`,
      hint: `Fix the YAML in ${file}.`,
    });
  }
  return doc.toJS();
}

function isMap(value: unknown): value is Tree {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dropNulls(value: object): Tree {
  const tree: Tree = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === undefined) continue;
    tree[key] = isMap(item) ? dropNulls(item) : (item as string | string[]);
  }
  return tree;
}

function mergeTrees(base: Tree, top: Tree): Tree {
  const merged: Tree = { ...base };
  for (const [key, value] of Object.entries(top)) {
    const old = merged[key];
    merged[key] = isMap(old) && isMap(value) ? mergeTrees(old, value) : value;
  }
  return merged;
}

/** Every leaf of `tree` in dotted form. A list is one leaf. */
function leaves(tree: Tree, prefix = ""): [string, string | string[]][] {
  return Object.entries(tree).flatMap(([key, value]) =>
    isMap(value)
      ? leaves(value, `${prefix}${key}.`)
      : [[`${prefix}${key}`, value] as [string, string | string[]]],
  );
}

function sourceOf(sources: Map<string, string>, key: string): ConfigSource {
  const path = sources.get(key);
  return path === undefined ? { kind: "default" } : { kind: "file", path };
}

/** Relative is relative to the codebase, a leading `~` is `home`, nothing else is expanded. */
function resolveProjectsDir(
  value: string,
  codebase: string,
  home: string,
): string {
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith(`~${sep}`)) {
    return join(home, value.slice(2));
  }
  return isAbsolute(value) ? value : resolve(codebase, value);
}
