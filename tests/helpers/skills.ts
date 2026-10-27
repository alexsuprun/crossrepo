import type { Command } from "commander";
import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { parse } from "yaml";

const FRONTMATTER_KEYS = ["name", "description", "license"];
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;
const MAX_LINES = 500;
/** Tokens that end one shell command, so the words after them are not `xr` arguments. */
const COMMAND_ENDS = new Set(["|", "||", "&&", ";", "&", ">", ">>", "2>"]);

/** Every command path of the `xr` program, space-joined, mapped to its subcommand names. */
export function commandPaths(program: Command): Map<string, Set<string>> {
  const paths = new Map<string, Set<string>>();
  const walk = (command: Command, path: string) => {
    paths.set(path, new Set(command.commands.map((child) => child.name())));
    for (const child of command.commands) {
      walk(child, path ? `${path} ${child.name()}` : child.name());
    }
  };
  walk(program, "");
  return paths;
}

function readFrontmatter(text: string): Record<string, unknown> | undefined {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (!match) return undefined;
  const data = parse(match[1] ?? "");
  return data && typeof data === "object" ? data : undefined;
}

/** Problems with the frontmatter and size of one `SKILL.md`, each as `file:line: message`. */
export function checkFrontmatter(
  file: string,
  folder: string,
  text: string,
): string[] {
  const at = (message: string) => `${file}:1: ${message}`;
  const data = readFrontmatter(text);
  if (!data) return [at("has no YAML frontmatter")];
  const problems: string[] = [];
  for (const key of Object.keys(data)) {
    if (!FRONTMATTER_KEYS.includes(key)) {
      problems.push(at(`frontmatter key "${key}" is not allowed`));
    }
  }
  for (const key of FRONTMATTER_KEYS) {
    if (!(key in data)) problems.push(at(`frontmatter has no "${key}"`));
  }
  const { name, description, license } = data;
  if ("name" in data) {
    if (name !== folder) {
      problems.push(at(`name "${name}" is not the folder name "${folder}"`));
    }
    if (typeof name !== "string" || !NAME_RE.test(name)) {
      problems.push(at(`name "${name}" does not match ${NAME_RE}`));
    } else if (name.length > MAX_NAME) {
      problems.push(at(`name has more than ${MAX_NAME} characters`));
    }
  }
  if ("description" in data) {
    if (typeof description !== "string" || description.length === 0) {
      problems.push(at("description is empty"));
    } else {
      if (description.length > MAX_DESCRIPTION) {
        problems.push(
          at(`description has more than ${MAX_DESCRIPTION} characters`),
        );
      }
      if (/[<>]/.test(description)) {
        problems.push(at("description has a < or > character"));
      }
    }
  }
  if ("license" in data && license !== "MIT") {
    problems.push(at(`license "${license}" is not MIT`));
  }
  const lines = text.replace(/\n$/, "").split("\n").length;
  if (lines >= MAX_LINES) {
    problems.push(at(`has ${lines} lines, not fewer than ${MAX_LINES}`));
  }
  return problems;
}

/** Where an `xr` call starts in a line: after whitespace, `$(`, a quote or a backtick. */
const XR_CALL = /(?:^|[\s"'`]|\$\()xr(?=$|[\s"'`)])/g;

/** The command words after each `xr` call of one line, without flags and `<args>`. */
function xrCalls(line: string): string[][] {
  const calls: string[][] = [];
  for (const match of line.matchAll(XR_CALL)) {
    const rest = line.slice(match.index + match[0].length);
    const words: string[] = [];
    for (const raw of rest.split(/\s+/).filter(Boolean)) {
      if (COMMAND_ENDS.has(raw) || raw.startsWith("#")) break;
      const word = raw.replace(/[;,.)"'`]+$/, "");
      if (word && !/^[-<[]/.test(word)) words.push(word);
      // A closing parenthesis or quote ends the call.
      if (/[)"'`]$/.test(raw)) break;
    }
    calls.push(words);
  }
  return calls;
}

/** The first `xr` words of `words` that are not a command, or undefined when the call is valid. */
function unknownCommand(
  words: string[],
  paths: Map<string, Set<string>>,
): string | undefined {
  let path = "";
  for (const word of words) {
    const children = paths.get(path) ?? new Set<string>();
    if (children.size === 0) return undefined;
    if (!children.has(word))
      return ["xr", path, word].filter(Boolean).join(" ");
    path = path ? `${path} ${word}` : word;
  }
  return undefined;
}

const KEBAB_TOKEN = /^[a-z0-9]+(-[a-z0-9]+)+$/;

/** Problems with backticked kebab-case words of one `SKILL.md` that are not in `known`, each as `file:line: message`. */
export function checkCodeTokens(
  file: string,
  text: string,
  known: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  const visit = (node: Nodes) => {
    if (node.type === "inlineCode" && KEBAB_TOKEN.test(node.value)) {
      if (!known.has(node.value)) {
        problems.push(
          `${file}:${node.position?.start.line ?? 0}: unknown code "${node.value}"`,
        );
      }
    }
    if ("children" in node) node.children.forEach(visit);
  };
  visit(fromMarkdown(text));
  return problems;
}

/** Problems with the `xr` commands of one `SKILL.md`, each as `file:line: message`. */
export function checkCliNames(
  file: string,
  text: string,
  paths: Map<string, Set<string>>,
): string[] {
  const problems: string[] = [];
  const visit = (node: Nodes) => {
    if (node.type === "inlineCode" || node.type === "code") {
      const start = node.position?.start.line ?? 0;
      // A code block starts with its fence line, so its text starts one line later.
      const first = node.type === "code" ? start + 1 : start;
      node.value.split("\n").forEach((line, offset) => {
        for (const words of xrCalls(line)) {
          const unknown = unknownCommand(words, paths);
          if (unknown) {
            problems.push(
              `${file}:${first + offset}: unknown command "${unknown}"`,
            );
          }
        }
      });
    }
    if ("children" in node) node.children.forEach(visit);
  };
  visit(fromMarkdown(text));
  return problems;
}
