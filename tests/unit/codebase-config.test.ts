import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import {
  addRepoEntry,
  codebaseConfigName,
  codebaseRepos,
  removeRepoEntry,
  renderCodebaseConfig,
  repoKeys,
} from "../../src/domain/codebase-config.ts";
import { XrError } from "../../src/errors/index.ts";

const HOOKS = `
# project:
#   pre-create:
#     # Stop the create before it makes anything when a tool is missing.
#     - command -v node >/dev/null || { echo "node is not installed"; exit 1; }
#   post-create:
#     # Copy untracked files, such as .env, into each new worktree.
#     - |
#       printf '%s\\n' "$CROSSREPO_PROJECT_REPOS" | while read -r repo; do
#         cp "$CROSSREPO_CODEBASE_PATH/$repo/.env" "$CROSSREPO_PROJECT_PATH/$repo/" 2>/dev/null || true
#       done
#   pre-remove:
#     # Stop the remove when a worktree has commits that are not pushed.
#     - |
#       printf '%s\\n' "$CROSSREPO_PROJECT_REPOS" | while read -r repo; do
#         if [ -n "$(git -C "$CROSSREPO_PROJECT_PATH/$repo" log '@{upstream}..' --oneline)" ]; then
#           echo "$repo has unpushed commits"; exit 1
#         fi
#       done
#   post-remove:
#     # Clean up outside the project folder after it is removed, such as a tmux session with the name of the project.
#     - tmux kill-session -t "$CROSSREPO_PROJECT_NAME" 2>/dev/null || true
`;

const HEADER =
  "# crossrepo codebase config. Docs: https://alexsuprun.github.io/crossrepo/\n";

describe("renderCodebaseConfig", () => {
  test("gives the header, one entry per repo and the commented hook examples", () => {
    expect(
      renderCodebaseConfig([
        {
          name: "api",
          remote: "git@github.com:acme/api.git",
          defaultBranch: "main",
        },
      ]),
    ).toBe(
      `${HEADER}repos:\n  api:\n    remote: git@github.com:acme/api.git\n    default-branch: main\n    description: ""\n${HOOKS}`,
    );
  });

  test("no repos is repos: {}", () => {
    expect(renderCodebaseConfig([])).toBe(`${HEADER}repos: {}\n${HOOKS}`);
  });

  test("quotes values that YAML would read as something else, and parses back", () => {
    const repos = [
      { name: "true", remote: "a: b", defaultBranch: "#x" },
      { name: "my repo", remote: "x".repeat(120), defaultBranch: "1.0" },
      { name: "new\nline", remote: "'q' \"d\"", defaultBranch: "main" },
    ];
    const text = renderCodebaseConfig(repos);
    expect(parse(text)).toEqual({
      repos: Object.fromEntries(
        repos.map(({ name, remote, defaultBranch }) => [
          name,
          { remote, "default-branch": defaultBranch, description: "" },
        ]),
      ),
    });
    expect(text).toContain(`remote: ${"x".repeat(120)}\n`);
  });
});

const NEW = {
  name: "new",
  remote: "file:///o/new.git",
  defaultBranch: "main",
};
const NEW_LINES =
  '  new:\n    remote: file:///o/new.git\n    default-branch: main\n    description: ""\n';

/** A hand-edited config with comments, a folded text and an end-of-file comment. */
const HAND_EDITED = `# top comment
name: shop   # inline comment
repos:
  # the api
  api:
    remote: git@github.com:acme/api.git  # inline remote
    default-branch: main
    description: >
      A long
      folded text
  web:
    remote: "https://example.com/web.git"
    default-branch: trunk
    description: ''
# between
projects-dir: .p

# end comment
`;

describe("addRepoEntry", () => {
  test("adds the entry at the end of repos: in the init config and keeps the rest", () => {
    const text = renderCodebaseConfig([
      { name: "api", remote: "/o/api.git", defaultBranch: "main" },
    ]);
    const [head, tail] = text.split("\n\n# project:");
    expect(addRepoEntry(text, NEW)).toBe(
      `${head}\n${NEW_LINES}\n# project:${tail}`,
    );
  });

  test("turns repos: {} into a block map", () => {
    const text = renderCodebaseConfig([]);
    expect(addRepoEntry(text, NEW)).toBe(
      text.replace("repos: {}\n", `repos:\n${NEW_LINES}`),
    );
  });

  test("a hand-edited config changes only in comment spacing and the folded text (pinned)", () => {
    expect(addRepoEntry(HAND_EDITED, NEW)).toBe(`# top comment
name: shop # inline comment
repos:
  # the api
  api:
    remote: git@github.com:acme/api.git # inline remote
    default-branch: main
    description: >
      A long folded text
  web:
    remote: "https://example.com/web.git"
    default-branch: trunk
    description: ''
${NEW_LINES}# between
projects-dir: .p

# end comment
`);
  });

  test("a second write changes nothing more than its own entry", () => {
    const once = addRepoEntry(HAND_EDITED, NEW);
    const twice = addRepoEntry(once, { ...NEW, name: "next" });
    expect(twice).toBe(
      once.replace(
        `${NEW_LINES}`,
        `${NEW_LINES}${NEW_LINES.replace("  new:", "  next:")}`,
      ),
    );
  });

  test("a missing or null repos becomes a block map", () => {
    expect(addRepoEntry("name: shop\n", NEW)).toBe(
      `name: shop\nrepos:\n${NEW_LINES}`,
    );
    expect(addRepoEntry("repos:\nname: x\n", NEW)).toBe(
      `repos:\n${NEW_LINES}name: x\n`,
    );
    expect(addRepoEntry("repos: ~\n", NEW)).toBe(`repos:\n${NEW_LINES}`);
    expect(addRepoEntry("", NEW)).toBe(`repos:\n${NEW_LINES}`);
  });

  test("quotes values that YAML would read as something else", () => {
    const repo = { name: "true", remote: "a: b", defaultBranch: "1.0" };
    expect(parse(addRepoEntry("repos: {}\n", repo))).toEqual({
      repos: {
        true: { remote: "a: b", "default-branch": "1.0", description: "" },
      },
    });
  });

  test("repos that is not a map is invalid-config", () => {
    expect(() => addRepoEntry("repos: [a]\n", NEW)).toThrow(XrError);
    expect(() => addRepoEntry("repos: [\n", NEW)).toThrow(XrError);
  });
});

describe("removeRepoEntry", () => {
  test("removes the last entry of the init config: repos: {} and the rest stays", () => {
    const text = renderCodebaseConfig([
      { name: "api", remote: "/o/api.git", defaultBranch: "main" },
    ]);
    expect(removeRepoEntry(text, "api")).toBe(renderCodebaseConfig([]));
  });

  test("a hand-edited config loses only the entry and its own comments (pinned)", () => {
    expect(removeRepoEntry(HAND_EDITED, "web")).toBe(`# top comment
name: shop # inline comment
repos:
  # the api
  api:
    remote: git@github.com:acme/api.git # inline remote
    default-branch: main
    description: >
      A long folded text
# between
projects-dir: .p

# end comment
`);
  });

  test("a comment above the first entry stays, since it may be about all repos (pinned)", () => {
    expect(removeRepoEntry(HAND_EDITED, "api")).toBe(`# top comment
name: shop # inline comment
repos:
  # the api
  web:
    remote: "https://example.com/web.git"
    default-branch: trunk
    description: ''
# between
projects-dir: .p

# end comment
`);
  });

  test("an emptied map is repos: {}, with a comment above the first entry moved above repos (pinned)", () => {
    const once = removeRepoEntry(HAND_EDITED, "api");
    expect(removeRepoEntry(once, "web")).toBe(`# top comment
name: shop # inline comment
# the api
repos: {}
# between
projects-dir: .p

# end comment
`);
  });

  test("removes a key with a null value", () => {
    expect(removeRepoEntry("repos:\n  api:\n  web: ~\n", "api")).toBe(
      "repos:\n  web: ~\n",
    );
    expect(removeRepoEntry("repos:\n  api:\n", "api")).toBe("repos: {}\n");
  });

  test("matches the key as written, so 1.0 is not 1", () => {
    expect(removeRepoEntry("repos:\n  1.0:\n  '1': ~\n", "1")).toBe(
      "repos:\n  1.0:\n",
    );
    expect(removeRepoEntry("repos:\n  1.0:\n  '1': ~\n", "1.0")).toBe(
      "repos:\n  '1': ~\n",
    );
  });

  test("a name that is not a key gives the text unchanged", () => {
    expect(removeRepoEntry(HAND_EDITED, "nope")).toBe(HAND_EDITED);
    expect(removeRepoEntry("name: x\n", "api")).toBe("name: x\n");
  });

  test("repos that is not a map is invalid-config", () => {
    expect(() => removeRepoEntry("repos: [a]\n", "a")).toThrow(XrError);
  });
});

describe("repoKeys", () => {
  test("gives every key of repos:, also a key with a null value", () => {
    expect(repoKeys(HAND_EDITED)).toEqual(["api", "web"]);
    expect(repoKeys("repos:\n  api:\n  web: ~\n")).toEqual(["api", "web"]);
  });

  test("keeps a key as written, so 1.0 is not read as 1", () => {
    expect(repoKeys("repos:\n  1.0:\n  0x1f: ~\n  '2.0': ~\n")).toEqual([
      "1.0",
      "0x1f",
      "2.0",
    ]);
  });

  test("no repos, null repos or an empty file gives no keys", () => {
    expect(repoKeys("name: x\n")).toEqual([]);
    expect(repoKeys("repos:\n")).toEqual([]);
    expect(repoKeys("")).toEqual([]);
  });
});

describe("codebaseRepos", () => {
  test("gives each repo name and description in config order", () => {
    expect(codebaseRepos(HAND_EDITED)).toEqual([
      { name: "api", description: "A long folded text\n" },
      { name: "web", description: "" },
    ]);
    expect(codebaseRepos("repos:\n  1.0:\n  b: {}\n")).toEqual([
      { name: "1.0", description: undefined },
      { name: "b", description: undefined },
    ]);
    expect(codebaseRepos("")).toEqual([]);
  });
});

describe("codebaseConfigName", () => {
  test("is config.yml only when config.yaml is missing and config.yml exists", () => {
    const has =
      (...names: string[]) =>
      (name: string) =>
        names.includes(name);
    expect(codebaseConfigName(has("config.yaml"))).toBe("config.yaml");
    expect(codebaseConfigName(has("config.yml"))).toBe("config.yml");
    expect(codebaseConfigName(has("config.yaml", "config.yml"))).toBe(
      "config.yaml",
    );
    expect(codebaseConfigName(has())).toBe("config.yaml");
  });
});
