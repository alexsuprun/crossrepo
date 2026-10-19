import { readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

/** A source file, with `path` relative to the repo root in `/` form, e.g. `src/cli/index.ts`. */
export interface SourceFile {
  path: string;
  source: string;
}

export interface Violation {
  file: string;
  specifier: string;
  rule: string;
}

/**
 * Allowed import arrows between layers, from the architecture layer table.
 * Imports inside one layer are always allowed, except between two commands.
 */
const ALLOWED: Record<string, readonly string[]> = {
  cli: ["commands", "adapters", "config", "output", "errors"],
  commands: ["services", "runners", "domain", "errors"],
  services: ["domain", "adapters", "errors"],
  runners: ["adapters", "errors"],
  domain: ["errors"],
  adapters: ["errors", "config"],
  config: [],
  output: [],
  errors: [],
};

const NODE_IO_LAYERS = new Set(["adapters", "config", "output"]);
const NODE_IO = /^(node:)?(fs|fs\/promises|child_process)$/;

const IMPORT_PATTERNS = [
  /\b(?:import|export)\s+([^;"'`]*?)\s*\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

interface Import {
  index: number;
  clause: string | undefined;
  specifier: string;
}

function findImports(source: string): Import[] {
  const found: Import[] = [];
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const [, first, second] = match;
      found.push(
        second === undefined
          ? {
              index: match.index,
              clause: undefined,
              specifier: first as string,
            }
          : { index: match.index, clause: first, specifier: second },
      );
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

/** The command unit of a file under `src/commands/`: `<group>/<command>`. */
function commandUnit(parts: string[]): string {
  const [group = "", command] = parts.slice(2);
  return command === undefined
    ? stripExtension(group)
    : `${group}/${stripExtension(command)}`;
}

/** Checks every import in `files` against the layer rules and returns the violations. */
export function checkImports(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const parts = file.path.split("/");
    const layer = parts[1] ?? "";
    if (parts.length < 3 || !Object.hasOwn(ALLOWED, layer)) {
      violations.push({
        file: file.path,
        specifier: "",
        rule: `${parts.slice(0, 2).join("/")} is not a layer folder`,
      });
      continue;
    }
    for (const { clause, specifier } of findImports(file.source)) {
      const rule = checkImport(parts, layer, clause, specifier);
      if (rule) {
        violations.push({ file: file.path, specifier, rule });
      }
    }
  }
  return violations;
}

function checkImport(
  parts: string[],
  layer: string,
  clause: string | undefined,
  specifier: string,
): string | undefined {
  if (!specifier.startsWith(".")) {
    if (NODE_IO.test(specifier) && !NODE_IO_LAYERS.has(layer)) {
      return `${layer} may not import ${specifier}`;
    }
    if (specifier.startsWith("@clack/"))
      return checkClack(parts, clause, specifier);
    return undefined;
  }
  const target = posix
    .normalize(posix.join(posix.dirname(parts.join("/")), specifier))
    .split("/");
  if (target[0] !== "src" || target.length < 3) {
    return `${layer} may not import files outside src/`;
  }
  const targetLayer = target[1] as string;
  if (targetLayer === layer) {
    if (layer === "commands") {
      const from = commandUnit(parts);
      const to = commandUnit(target);
      if (from !== to) {
        return `command ${from} may not import command ${to}`;
      }
    }
    return undefined;
  }
  if (
    !Object.hasOwn(ALLOWED, targetLayer) ||
    !ALLOWED[layer]?.includes(targetLayer)
  ) {
    return `${layer} may not import ${targetLayer}`;
  }
  if (
    layer === "adapters" &&
    targetLayer === "config" &&
    !/^(type\s+)?\{\s*(type\s+)?writeFileAtomic(\s+as\s+[\w$]+)?\s*,?\s*\}$/.test(
      clause ?? "",
    )
  ) {
    return "adapters may import only writeFileAtomic from config";
  }
  return undefined;
}

/**
 * Only `src/adapters/prompt` uses clack, and never its `spinner`, `tasks` or
 * `block` (AD-4, AD-5). A namespace or dynamic import could reach them, so it is refused too.
 */
function checkClack(
  parts: string[],
  clause: string | undefined,
  specifier: string,
): string | undefined {
  if (parts.slice(0, 3).join("/") !== "src/adapters/prompt") {
    return `only src/adapters/prompt may import ${specifier}`;
  }
  if (
    clause === undefined ||
    clause.includes("*") ||
    /\b(spinner|tasks|block)\b/.test(clause)
  ) {
    return `${specifier} may not be used for spinner, tasks or block`;
  }
  return undefined;
}

/** Reads every JS and TS file under the `src/` folder at `srcDir`. */
export function readSourceFiles(srcDir: URL): SourceFile[] {
  const root = fileURLToPath(srcDir);
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((name) => /\.[cm]?[jt]sx?$/.test(name))
    .sort()
    .map((name) => ({
      path: `src/${name.replaceAll("\\", "/")}`,
      source: readFileSync(`${root}/${name}`, "utf8"),
    }));
}
