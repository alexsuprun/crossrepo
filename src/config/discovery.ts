import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { CODEBASE_PATH_HINT, ConfigError } from "./errors.ts";

/**
 * What the folder is (AD-9). For a project, `codebase` comes from its record.
 * `broken-project`: a record exists but gives no codebase; `error` is what
 * every command that does not accept this kind throws.
 */
export type Discovery =
  | { kind: "none"; dir: string }
  | { kind: "codebase"; dir: string; codebase: string }
  | { kind: "project"; dir: string; codebase: string }
  | { kind: "broken-project"; dir: string; error: ConfigError };

/** Looks at `dir` only, never a parent folder (D51). `dir` must be absolute. */
export function discover(dir: string): Discovery {
  const record = join(dir, ".crossrepo", "project.yaml");
  if (existsSync(record)) {
    try {
      return { kind: "project", dir, codebase: codebaseOf(record, dir) };
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      return { kind: "broken-project", dir, error };
    }
  }
  return isCodebase(dir)
    ? { kind: "codebase", dir, codebase: dir }
    : { kind: "none", dir };
}

function isCodebase(dir: string): boolean {
  return ["config.yaml", "config.yml"].some((name) =>
    existsSync(join(dir, ".crossrepo", name)),
  );
}

function codebaseOf(record: string, project: string): string {
  const doc = parseDocument(readFileSync(record, "utf8"));
  const data: unknown = doc.errors.length ? undefined : doc.toJS();
  const path =
    typeof data === "object" && data !== null && "codebase" in data
      ? data.codebase
      : undefined;
  if (typeof path !== "string" || path === "") {
    throw new ConfigError({
      kind: "not-a-codebase",
      message: `The project record ${record} has no \`codebase\` path.`,
      hint: CODEBASE_PATH_HINT,
    });
  }
  const codebase = resolve(project, path);
  if (!isCodebase(codebase)) {
    throw new ConfigError({
      kind: "not-a-codebase",
      message: `The project at ${project} points to ${codebase}, which is not a codebase.`,
      hint: CODEBASE_PATH_HINT,
    });
  }
  return codebase;
}
