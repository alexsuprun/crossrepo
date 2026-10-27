# SPEC: xr-hooks

Design contract for the `xr-hooks` skill. Source: Story 6.1 in the planning `epics.md` (issue #88) and `spec-6-1-agent-skills.md`. The story names this skill `crossrepo-hooks`; the user renamed it to `xr-hooks` on 2026-10-27.

## Name and description

- Name: `xr-hooks` (bare, equals the folder `skills/xr-hooks/`).
- Frontmatter: only `name`, `description`, `license: MIT`. No `model`, no `allowed-tools`, no `disallowed-tools`, no `version`.
- Description (no angle brackets, under 1024 characters):

  Writes crossrepo project hooks (pre-create, post-create, pre-remove, post-remove) and project.vars in the right crossrepo config file, as POSIX sh that needs no input, so the hook works on the first run. Reads the current config with xr config show first, asks which config level gets the hook, keeps comments and key order, and checks the result with xr codebase doctor. Use when the user wants xr to run a command when a project is created or removed, such as installing dependencies, copying .env files, or cleanup. Triggers on "add a post-create hook", "run npm ci after xr project create", "copy .env into each new project", "add a crossrepo hook", "clean up when a project is removed", "set a hook variable".

## Triggers

- "add a post-create hook that runs npm ci in api"
- "copy the .env files into each new worktree"
- "kill the tmux session when the project is removed"
- "check that docker runs before a project is made"
- "add a project var PORT"

Example invocations:

1. User: "Run npm ci in api after each project create." Agent runs `xr config show --json --no-interactive`, tells the user the hooks that exist with their files, asks the level, writes a `project.post-create` line, says that the codebase config is in git so hooks run for every teammate with no trust step, runs the doctor, and offers a test.
2. User: "Stop the remove when a worktree has a running dev server." Agent writes a `pre-remove` check, since `pre-` hooks check and `post-` hooks do the work.
3. User: "Add DB_NAME=app for all hooks." Agent adds `project.vars.DB_NAME` and refuses a name that starts with `CROSSREPO_`.

## Contents

- `SKILL.md` and `references/commands.md`. `references/commands.md` holds the `--help` text of every `xr` command. `bun run skills:refs` writes it from `createProgram`, the same file in each of the 3 skills, because `npx skills add --skill <name>` installs only that folder. Never edit it by hand. No `scripts/`, no `assets/`, no `example-*` template files. No `.sh` files: hook examples go inline in `SKILL.md`.

## Per-step scripting verdicts

| Step | Verdict | Reason |
| --- | --- | --- |
| Run `xr config show --json --no-interactive` and summarise hooks and vars | LLM | One call plus a summary for the user. |
| Ask the level | LLM | A conversation. |
| Pick the hook and write the `sh` lines | LLM | Writing code from the user's need. |
| Edit the YAML file, keeping comments and key order | LLM | A hand edit; a YAML rewrite would lose comments. |
| Warn about configs in git | LLM | Depends on whether the file is tracked. |
| Run the doctor and show results | LLM | One call and a summary. |
| Offer and run a test | LLM | Needs the user's yes and judgment on names. |

## Wiring

- Same plugin as `xr`: `.claude-plugin/plugin.json` (`name: "xr"`) and `.claude-plugin/marketplace.json` (one plugin `xr`, `source: "./"`) at the repo root exist already. No change needed.
- After plugin install the skill shows as `xr:xr-hooks`.
- No `disallowed-tools`.

## Body outline

H1 is `# xr-hooks`. `SKILL.md` never links to this `SPEC.md`. No copy of docs pages; link `references/commands.md` once for flags and arguments, and point to the hooks guide (`https://alexsuprun.github.io/crossrepo/guides/hooks/`) and "Output and errors" (`https://alexsuprun.github.io/crossrepo/output/`). Every `xr` call uses `--json` and `--no-interactive`; branch on `error.code`.

1. One line: what the skill does.
2. **Rules** — never save a hook or run a test without the user's yes. Edit config by hand: keep comments and key order, change only the keys of the hook. Never overwrite a line the user did not agree to change.
3. **Read the config first** — `xr config show --json --no-interactive`. Tell the user which hooks and `project.vars` exist already, with the file each comes from.
4. **Ask the level** — `.crossrepo/config.yaml` of the codebase (shared with the team), `.crossrepo/config.local.yaml` (this user, this codebase), `~/.crossrepo/config.yaml` (this user, all codebases). Files may end in `.yml`; edit the one that exists. The order is user, codebase, local: a later level wins, and a hook list in a later level replaces the whole list of an earlier one (`project.vars` merges key by key). When `xr config show` gives the same hook from a later level than the chosen one, warn the user before saving: the new lines never run. Edit only the chosen file.
5. **Hook facts** — a table of the 4 hooks under `project:`:
   - `pre-create`: codebase folder, before anything is made; a failure makes nothing.
   - `post-create`: project folder, after the worktrees and `AGENTS.md`; a failure undoes the whole create (not what the hook did itself).
   - `pre-remove`: project folder, before anything is removed; a failure keeps the project whole. `--force` does not skip it.
   - `post-remove`: codebase folder, after the removal; a failure is only a warning.
   - `pre-` hooks check, `post-` hooks do the work. Only `xr project create` and `xr project remove` run hooks.
   - Each list item is its own `sh -c`, in list order; the first failed line stops the hook. stdin is closed, so a line cannot ask questions. Each line has a 10-minute limit. Output goes to stderr. A hook runs once per project, not per repo; loop over `$CROSSREPO_PROJECT_REPOS` (one repo per line).
6. **Variables** — the 7 vars `CROSSREPO_HOOK`, `CROSSREPO_CODEBASE_PATH`, `CROSSREPO_CODEBASE_NAME`, `CROSSREPO_PROJECT_PATH`, `CROSSREPO_PROJECT_NAME`, `CROSSREPO_PROJECT_BRANCH`, `CROSSREPO_PROJECT_REPOS`, plus each `project.vars` entry under its exact name. Use only these and the user's normal environment. Never give a `project.vars` entry a name that starts with `CROSSREPO_` in any case: that is the error `reserved-var-name`. Each name matches `[A-Za-z_][A-Za-z0-9_]*`, so `sh` can use it. Values are text; quote a value that must stay as written, such as `"1.10"`.
7. **Write the lines** — POSIX `sh`, not Bash or PowerShell (on Windows hooks run in the `sh` of Git for Windows). Quote every variable. No prompts, no `read`. Write a line as a quoted YAML string or a `|` block when it has a colon and a space, a space and `#`, or a first character that YAML gives a meaning. A short YAML example with a `post-create` loop over the repos and a `pre-create` check.
8. **Config in git** — when the chosen file is kept in git (check with `git ls-files` or ask), tell the user that hooks run as each teammate who uses the config, with their rights, and with no trust step.
9. **Finish** — run `xr codebase doctor --json --no-interactive`. Show each `reserved-var-name` and `unknown-config-key` item that is not `ok`, with its `fix`.
10. **Offer a test** — only with the user's yes: `xr project create <test-branch> <repo> --json --no-interactive` on a new test branch, then, only when the create result has `ok: true`, `xr project remove <project> --json --no-interactive`. Never run a hook any other way. On `hook-failed`, show `error.details` (`command`, `exitCode`, `timedOut`, `hookOutput.lines`). After `xr project remove`, also read `warnings`: a failed `post-remove` line is a `hook-failed` warning, and the remove still succeeds. The test branch stays after the remove; delete it only with the user's yes.
