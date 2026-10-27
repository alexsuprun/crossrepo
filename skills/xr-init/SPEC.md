# SPEC: xr-init

Design contract for the `xr-init` skill. Source: Story 6.1 in the planning `epics.md` (issue #88) and `spec-6-1-agent-skills.md`. The story names this skill `crossrepo-init`; the user renamed it to `xr-init` on 2026-10-27.

## Name and description

- Name: `xr-init` (bare, equals the folder `skills/xr-init/`).
- Frontmatter: only `name`, `description`, `license: MIT`. No `model`, no `allowed-tools`, no `disallowed-tools`, no `version`.
- Description (no angle brackets, under 1024 characters):

  Sets up a crossrepo codebase with xr codebase init and writes a description of each repo: a one-line description in .crossrepo/config.yaml and a section for each repo under "## Repos" in the codebase AGENTS.md, so every agent in a later project knows what each repo does. Drafts come from the README, package manifest and AGENTS.md of each repo, and nothing is saved before the user agrees. Also refreshes existing descriptions as a diff. Use when the user wants to make a folder of repos a crossrepo codebase, or to write, update or refresh the repo descriptions. Triggers on "set up crossrepo here", "init a codebase", "xr codebase init", "describe the repos", "refresh the repo descriptions", "update AGENTS.md with what each repo does".

## Triggers

- "set up crossrepo in this folder" / "make this a codebase"
- "describe each repo for the agents"
- "refresh the repo descriptions" / "the descriptions are out of date"
- "xr codebase init said already-a-codebase"

Example invocations:

1. Set up: in `~/work/acme` with repos `api` and `web`, the agent runs `xr codebase init --json --no-interactive`, reads each repo's README, `package.json` and `AGENTS.md`, shows two drafts as one list, and saves only what the user accepts.
2. Refresh: `xr codebase init` fails with `already-a-codebase`; the agent reads every repo again and proposes one diff at a time.
3. Refresh with a stale heading: `AGENTS.md` has `### billing`, but `billing` is not in the config; the agent flags it and does not delete it by itself.

## Contents

- `SKILL.md` and `references/commands.md`. `references/commands.md` holds the `--help` text of every `xr` command. `bun run skills:refs` writes it from `createProgram`, the same file in each of the 3 skills, because `npx skills add --skill <name>` installs only that folder. Never edit it by hand. No `scripts/`, no `assets/`, no `example-*` template files.

## Per-step scripting verdicts

| Step | Verdict | Reason |
| --- | --- | --- |
| Pick the mode (set up or refresh) | LLM | Depends on the `xr` result and the user's words. |
| Run `xr codebase init --json --no-interactive` | LLM | One shell call; a script adds nothing. |
| Read README, manifest and `AGENTS.md` of each repo | LLM | Files and formats differ per repo; needs judgment on what matters. |
| Draft the description and the `###` section | LLM | Writing text. |
| Review with the user | LLM | A conversation. |
| Edit `.crossrepo/config.yaml`, keeping comments and key order | LLM | A hand edit of one value; a YAML rewrite tool would lose comments. |
| Edit `AGENTS.md` (`## Repos`, the one `## Codebase` line) | LLM | A targeted text edit. |
| Run `xr codebase doctor --json --no-interactive` and show the results | LLM | One call and a summary. |

## Wiring

- Same plugin as `xr`: plugin root is the repo root, `.claude-plugin/plugin.json` (`name: "xr"`) and `.claude-plugin/marketplace.json` (one plugin `xr`, `source: "./"`) exist already. No change needed.
- After plugin install the skill shows as `xr:xr-init`.
- No `disallowed-tools`.

## Body outline

H1 is `# xr-init`. `SKILL.md` never links to this `SPEC.md`. No copy of docs pages; link `references/commands.md` once for flags and arguments, and point to the docs page "Output and errors" (`https://alexsuprun.github.io/crossrepo/output/`). Every `xr` call uses `--json` and `--no-interactive`.

1. One line: what the skill does.
2. **Rules** — read only files in each repo; never run code from a repo (no install, build, test or script). Save nothing until the user agrees. Never overwrite text the user did not accept. Edit config by hand: keep comments and key order, change only `description` values.
3. **Pick the mode**
   - Set up: the folder is not a codebase yet. Run `xr codebase init --json --no-interactive`. On `ok: false` with another code, show `message` and `hint` and stop.
   - Refresh: the user asks for it, or `xr codebase init` fails with `already-a-codebase`. Skip init.
   - The repos are the keys of `repos:` in `.crossrepo/config.yaml`; `xr codebase repo list --json --no-interactive` lists them with their descriptions. When it fails, show `message` and `hint` and stop.
4. **Read each repo** — skip a repo with `present: false` in `xr codebase repo list` (not on disk) and tell the user to run `xr codebase clone` first. Read its README, its package manifest (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml` and like files) and its own `AGENTS.md`. Nothing else is needed; never run anything in the repo.
5. **Draft** for each repo:
   - `description`: one line, what the repo is.
   - A `### <repo>` section: what the repo does, when a feature needs it, what it depends on (other repos of the codebase, services).
   - Facts only the user knows (for example "web always needs api") come from the user; ask for them in the review.
6. **Review (set up)** — show all drafts as one list. The user can change, keep or skip each one. Save nothing before that.
7. **Review (refresh)** — compare the new drafts with the current `description` and `###` text. Propose only the changes, as a diff, one change at a time; the user accepts or rejects each. Draft text for a repo that has no description or no section. Flag a `###` under `## Repos` that names no repo in the config (case is ignored); remove or rename it only with the user's yes.
8. **Save** what the user accepted:
   - `.crossrepo/config.yaml`: set `repos.<name>.description` to the one line. Keep all comments and the key order. Change no other key. Quote the line as a YAML string when it has a colon and a space, a space and `#`, or a first character that YAML gives a meaning.
   - Codebase `AGENTS.md`: write each `### <repo>` under `## Repos`. Add `## Repos` when it is missing, outside `## Codebase`.
   - `## Codebase` is written by `xr` (on `codebase init` and `codebase repo add|remove`). Change only the line of each repo with a new description, to the exact form `xr` writes: ``- `name` — description`` (an em dash, the description on one line with whitespace squeezed). A repo with no description has the line `` - `name` `` with no em dash; change it to the full form. Change no other line of `## Codebase`.
   - Project `AGENTS.md` files get the new text on the next `xr project create` or `xr project repo add|remove`; say so to the user.
9. **Finish** — run `xr codebase doctor --json --no-interactive`. Show each `agents-heading-no-repo` and `agents-repo-no-heading` item that is not `ok`, with its `fix`.
