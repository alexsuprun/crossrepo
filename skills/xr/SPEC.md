# SPEC: xr

Design contract for the `xr` skill. Source: Story 6.1 in the planning `epics.md` (issue #88) and `spec-6-1-agent-skills.md`. The story names this skill `crossrepo`; the user renamed it to `xr` on 2026-10-27.

## Name and description

- Name: `xr` (bare, equals the folder `skills/xr/`).
- Frontmatter: only `name`, `description`, `license: MIT`. No `model`, no `allowed-tools`, no `disallowed-tools`, no `version`.
- Description (no angle brackets, under 1024 characters):

  Runs the crossrepo CLI xr for the user and acts on its JSON result: calls every command with --json and --no-interactive, reads ok, error.code, repos, checks and leftovers, and handles error codes and merge conflicts of xr project sync. Use when the user asks to create, sync, remove, list or check a crossrepo project or codebase, or when an xr command failed. Triggers on "create a project for feat/x", "make a branch in all repos", "sync the project", "remove the project", "run xr doctor", "xr project create failed", "fix the sync conflict".

## Triggers

- "create a crossrepo project for feat/login in api and web"
- "sync my project with master" / "update the worktrees"
- "remove the project" / "clean up feat--login"
- "check the codebase" / "run the doctor"
- "xr project sync failed" / "there is a conflict after sync"

Example invocations:

1. User: "Make a project feat/login in api and web." Agent runs `xr project create feat/login api web --json --no-interactive`, reads `ok` and `repos`, and reports the project folder.
2. User: "Sync the project." Agent runs `xr project sync --json --no-interactive`, gets `repos-failed` with one repo in `status: conflict`, shows the `files`, and walks the user through the git steps.
3. User: "Remove feat--login." Agent gets `uncommitted-changes`, shows the repos, and asks before it adds `--force`.

## Contents

- `SKILL.md` and `references/commands.md`. `references/commands.md` holds the `--help` text of every `xr` command. `bun run skills:refs` writes it from `createProgram`, the same file in each of the 3 skills, because `npx skills add --skill <name>` installs only that folder. Never edit it by hand. No `scripts/`, no `assets/`, no `example-*` template files.
- No `.py` or `.sh` files anywhere in `skills/`.

## Per-step scripting verdicts

| Step | Verdict | Reason |
| --- | --- | --- |
| Pick the `xr` command and its arguments from the user's request | LLM | Needs language understanding. |
| Look up flags and arguments | LLM | The agent reads `references/commands.md`; no script adds value. |
| Run `xr ... --json --no-interactive` | LLM | One shell call; the command differs every time. |
| Read the JSON result and branch on `error.code` | LLM | Judgment about what to tell the user and what to ask. |
| Ask before `--force` or `--delete-branch` | LLM | A conversation step. |
| Fix sync conflicts with the user | LLM | Needs judgment on file content and user agreement. |

## Wiring

- Plugin root is the repo root. `skills/<name>/SKILL.md`, and `.claude-plugin/` at the repo root.
- `.claude-plugin/plugin.json`: `name: "xr"`, `description`, `author`, `homepage`, `repository`, `license: "MIT"`, `keywords`. Skills are found from the `skills/` folder, so no `skills` field is needed.
- `.claude-plugin/marketplace.json`: `name: "xr"`, `owner.name`, `plugins: [{ "name": "xr", "source": "./" }]` (plus a `description`).
- After install the skill shows as `xr:xr`. `npx skills add alexsuprun/crossrepo` installs it as `xr`.
- No `disallowed-tools`.

## Body outline

H1 is `# xr` (not skillkit's `# xr:xr`), because `npx skills` users run agents with no `plugin:` prefix. `SKILL.md` never links to this `SPEC.md`. Copy no docs pages: no list of all error codes. Flags and arguments come from `references/commands.md`, linked once.

1. One line: what the skill does.
2. **How to call `xr`** — always add `--json` and `--no-interactive`, so `xr` never waits for input. For flags and arguments read `references/commands.md`; never guess a flag. stdout is one JSON object; progress goes to stderr.
3. **How to read the result** — top-level `ok`, `warnings`, and on failure `error` with `code`, `message`, `hint` and sometimes `details`. Per-repo results are `repos` items with `repo`, `status` (`ok`, `skipped`, `failed`, `conflict`), `message`, `hint`, and for conflicts `files` and `stashKept`. Doctor results are `checks` items with `id`, `status`, `fix`. `leftovers` items with `what`, `path`, `command` list things an undo could not remove. Branch on `error.code`, never on the exit number. Show `error.hint` to the user. Link the full code list: `https://alexsuprun.github.io/crossrepo/output/`.
4. **Missing arguments** — on `missing-argument`, pick a value from `error.details.choices` when the request makes the choice clear, else ask the user with those choices.
5. **Rules** — never add `--force` or `--delete-branch` without the user's yes in this conversation. Never commit, push or delete files to make a command pass.
6. **Error codes** — a table under a heading named exactly "Error codes", first column the code in backticks, second the action. Only these codes: `uncommitted-changes` (show `error.details.worktrees` with their files, ask before `--force`), `would-lose-work` (show what would be lost, ask before `--force`), `lock-held` (another `xr` runs; wait, then try again once), `project-drift` (show `error.details.folders`; the user moves them out of the project folder; `--force` does not help), `repos-failed` (read `repos`, show each failed or conflicted repo, run `xr project doctor --json --no-interactive` or `xr codebase doctor --json --no-interactive`), `branch-in-use`, `project-exists`, `no-default-branch` (show the message and hint; let the user choose), `missing-argument` (see above). Any other code: show `message` and `hint`.
7. **Sync conflicts** — for `xr project sync`, for each repo item with `status: conflict`:
   - Show the user the `files`.
   - Fix the files only with the user's agreement.
   - Merge conflict (no `stashKept`): `git -C <path> add <files>`, then `GIT_EDITOR=true git -C <path> merge --continue` (no editor opens). To stop instead: `git -C <path> merge --abort`.
   - `stashKept: true` (the message says the changes stay in `git stash list`): the merge already passed and git already put the changes back with conflict markers, so `git stash pop` does not work. Fix the files with the user, then `git -C <path> reset`. Find the `autostash` entry with `git -C <path> stash list` (all worktrees of a repo share one stash list; ask when there is more than one), show it, and only after the user's yes run `git -C <path> stash drop <ref>` with that entry's ref. This follows the code (`src/services/project-sync.ts:106`) and the docs page of `xr project sync`, not the story text, which says `stash pop`.
   - After a resolved merge, run `xr project sync --json --no-interactive` again. Not after `merge --abort`: the same conflict comes back.
   - Take `<path>` from the repo item's hint, or the project folder plus the repo name.
