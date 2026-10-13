import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { renderCodebaseConfig } from "../../src/domain/codebase-config.ts";

const HOOKS = `
# project:
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
