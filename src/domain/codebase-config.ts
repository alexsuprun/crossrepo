import {
  type Document,
  isMap,
  isPair,
  isScalar,
  parseDocument,
  stringify,
} from "yaml";
import { XrError } from "../errors/index.ts";

/** One repo of a new codebase config. */
export interface ConfigRepo {
  name: string;
  /** The `origin` URL exactly as git gives it. */
  remote: string;
  defaultBranch: string;
}

const HEADER =
  "# crossrepo codebase config. Docs: https://alexsuprun.github.io/crossrepo/";

const HOOK_EXAMPLES = [
  "# project:",
  "#   post-create:",
  "#     # Copy untracked files, such as .env, into each new worktree.",
  "#     - |",
  `#       printf '%s\\n' "$CROSSREPO_PROJECT_REPOS" | while read -r repo; do`,
  `#         cp "$CROSSREPO_CODEBASE_PATH/$repo/.env" "$CROSSREPO_PROJECT_PATH/$repo/" 2>/dev/null || true`,
  "#       done",
  "#   pre-remove:",
  "#     # Stop the remove when a worktree has commits that are not pushed.",
  "#     - |",
  `#       printf '%s\\n' "$CROSSREPO_PROJECT_REPOS" | while read -r repo; do`,
  `#         if [ -n "$(git -C "$CROSSREPO_PROJECT_PATH/$repo" log '@{upstream}..' --oneline)" ]; then`,
  `#           echo "$repo has unpushed commits"; exit 1`,
  "#         fi",
  "#       done",
];

/** The text of a new `.crossrepo/config.yaml`, with repos in the given order. */
export function renderCodebaseConfig(repos: readonly ConfigRepo[]): string {
  const entries = repos.flatMap(({ name, remote, defaultBranch }) => [
    `  ${scalar(name)}:`,
    `    remote: ${scalar(remote)}`,
    `    default-branch: ${scalar(defaultBranch)}`,
    `    description: ""`,
  ]);
  return [
    HEADER,
    ...(entries.length ? ["repos:", ...entries] : ["repos: {}"]),
    "",
    ...HOOK_EXAMPLES,
    "",
  ].join("\n");
}

/** One YAML scalar on one line: quoted when plain text would read as something else. */
export function scalar(value: string): string {
  return stringify(value, { lineWidth: 0, blockQuote: false }).trimEnd();
}

/**
 * The keys of the `repos:` map in a codebase config text, also keys with a null
 * value, which the merged config drops.
 */
export function repoKeys(text: string): string[] {
  return codebaseRepos(text).map(({ name }) => name);
}

/**
 * The repos of a codebase config text in config order, with each name as
 * written (`1.0` stays `1.0`) and the description when it is a string.
 */
export function codebaseRepos(
  text: string,
): { name: string; description?: string }[] {
  const repos = reposNode(load(text));
  if (!repos) return [];
  return repos.items.map(({ key, value }) => {
    const description = isMap(value) ? value.get("description") : undefined;
    return {
      name: keyName(key),
      description: typeof description === "string" ? description : undefined,
    };
  });
}

/** The codebase config file name: `config.yml` only when it exists and `config.yaml` does not. */
export function codebaseConfigName(
  exists: (name: string) => boolean,
): "config.yaml" | "config.yml" {
  return !exists("config.yaml") && exists("config.yml")
    ? "config.yml"
    : "config.yaml";
}

/**
 * Adds `<name>: {remote, default-branch, description: ""}` as a block map at the
 * end of `repos:` with the `yaml` round trip and default `toString()` (AD-2), so
 * comments and key order stay. A missing, null or empty `repos` becomes a block map.
 */
export function addRepoEntry(text: string, repo: ConfigRepo): string {
  const doc = load(text);
  let repos = reposNode(doc);
  if (!repos) {
    repos = doc.createNode({});
    doc.set("repos", repos);
  }
  if (repos.items.length === 0) repos.flow = false;
  repos.set(
    repo.name,
    doc.createNode({
      remote: repo.remote,
      "default-branch": repo.defaultBranch,
      description: "",
    }),
  );
  return doc.toString();
}

/**
 * Removes the `repos:` entry whose key is `name` as written (also a key with a
 * null value) with the `yaml` round trip and default `toString()` (AD-2). The
 * entry's own comments go with it; a comment above the first entry stays.
 * An emptied map is `repos: {}`. A name that is not a key gives `text` unchanged.
 */
export function removeRepoEntry(text: string, name: string): string {
  const doc = load(text);
  const repos = reposNode(doc);
  const index = repos?.items.findIndex(({ key }) => keyName(key) === name);
  if (!repos || index === undefined || index < 0) return text;
  repos.items.splice(index, 1);
  if (repos.items.length === 0) {
    repos.flow = true;
    // A comment above the old first entry would print between `repos:` and `{}`.
    if (repos.commentBefore) {
      const pair = isMap(doc.contents)
        ? doc.contents.items.find(
            (item) => isPair(item) && keyName(item.key) === "repos",
          )
        : undefined;
      if (pair && isScalar(pair.key)) {
        pair.key.commentBefore = [pair.key.commentBefore, repos.commentBefore]
          .filter(Boolean)
          .join("\n");
        repos.commentBefore = undefined;
      }
    }
  }
  return doc.toString();
}

/** A YAML key or scalar as written, so `1.0` stays `1.0`. */
export function keyName(key: unknown): string {
  return isScalar(key) ? (key.source ?? String(key.value)) : String(key);
}

function load(text: string): Document {
  const doc = parseDocument(text);
  const [error] = doc.errors;
  if (error) {
    throw new XrError({
      code: "invalid-config",
      message: `Invalid YAML in the codebase config: ${error.message}`,
      hint: "Fix the YAML in the codebase config, then run the command again.",
    });
  }
  return doc;
}

/** The `repos:` map, or `undefined` when it is missing or null. */
function reposNode(doc: Document) {
  const repos = doc.get("repos", true);
  if (repos == null || (isScalar(repos) && repos.value === null)) {
    return undefined;
  }
  if (!isMap(repos)) {
    throw new XrError({
      code: "invalid-config",
      message: "`repos` in the codebase config is not a map.",
      hint: "Fix `repos` in the codebase config, then run the command again.",
    });
  }
  return repos;
}
