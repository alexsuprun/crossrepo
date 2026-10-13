import { stringify } from "yaml";

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
function scalar(value: string): string {
  return stringify(value, { lineWidth: 0, blockQuote: false }).trimEnd();
}
