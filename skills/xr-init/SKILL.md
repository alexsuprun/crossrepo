---
name: xr-init
description: 'Sets up a crossrepo codebase with xr codebase init and writes a description of each repo: a one-line description in .crossrepo/config.yaml and a section for each repo under "## Repos" in the codebase AGENTS.md, so every agent in a later project knows what each repo does. Drafts come from the README, package manifest and AGENTS.md of each repo, and nothing is saved before the user agrees. Also refreshes existing descriptions as a diff. Use when the user wants to make a folder of repos a crossrepo codebase, or to write, update or refresh the repo descriptions. Triggers on "set up crossrepo here", "init a codebase", "xr codebase init", "describe the repos", "refresh the repo descriptions", "update AGENTS.md with what each repo does".'
license: MIT
---

# xr-init

Set up a crossrepo codebase and describe each repo, in the config and in the codebase `AGENTS.md`, with the user's agreement.

## Rules

- Add `--json` and `--no-interactive` to every `xr` call. Branch on `error.code`, never on the exit number. For flags and arguments, read [references/commands.md](references/commands.md). For error codes, read [Output and errors](https://alexsuprun.github.io/crossrepo/output/).
- Read only files in each repo. Never run code from a repo: no install, build, test or script.
- Save nothing until the user agrees. Never overwrite text the user did not accept.
- Edit the config by hand. Keep every comment and the key order, and change only `description` values.

## 1. Pick the mode

- **Set up**: the folder is not a codebase yet. Run `xr codebase init --json --no-interactive`. When it fails with a code other than `already-a-codebase`, show `message` and `hint` and stop.
- **Refresh**: the user asks for a refresh, or `xr codebase init` fails with `already-a-codebase`. Skip init.

Get the repos and their current descriptions with `xr codebase repo list --json --no-interactive`. When it fails, show `message` and `hint` and stop. The config file is `.crossrepo/config.yaml` (or `.crossrepo/config.yml`) in the codebase folder.

## 2. Read each repo

Skip each repo with `present: false` in the repo list: it is not on disk. Tell the user to run `xr codebase clone` first.

For each repo, read only:

- its README;
- its package manifest: `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml` or a like file;
- its own `AGENTS.md`, when it has one.

## 3. Draft

For each repo, draft:

- a `description`: one line that says what the repo is;
- a `### <repo>` section: what the repo does, when a feature needs it, and what it depends on (other repos of the codebase, services).

Only the user knows some facts, for example "web always needs api". Ask for them in the review.

## 4. Review

- **Set up**: show all drafts as one list. The user can change, keep or skip each one.
- **Refresh**: compare the drafts with the current `description` and `###` text. Propose only the changes, as a diff, one change at a time, and let the user accept or reject each one. Draft text for a repo with no description or no section. Flag each `###` under `## Repos` that names no repo in the config (case is ignored). Rename or remove it only with the user's yes.

## 5. Save what the user accepted

1. In the config, set `repos.<name>.description` to the one line. Change no other key. Write the line as a quoted YAML string when it has a colon and a space (`: `), or a space and `#` (` #`), or it starts with a character that YAML gives a meaning, such as `[`, `{`, `&`, `*`, `!`, `|`, `>`, `%`, `@` or a quote.
2. In the codebase `AGENTS.md`, write each `### <repo>` section under `## Repos`. When `## Repos` is missing, add it, outside `## Codebase`.
3. `xr` owns `## Codebase` and writes it only on `xr codebase init` and `xr codebase repo add` or `remove`. For each repo with a new description, change only its line there, in the exact form `xr` writes: ``- `name` — description`` (an em dash, and the description on one line with runs of whitespace as one space). A repo with no description has the line `` - `name` `` with no em dash: change it to the full form when the repo gets a description. Change no other line of `## Codebase`.
4. Tell the user that project `AGENTS.md` files get the new text on the next `xr project create`, `xr project repo add` or `xr project repo remove`.

## 6. Finish

Run `xr codebase doctor --json --no-interactive`. Show each `agents-heading-no-repo` and `agents-repo-no-heading` item that is not `ok`, with its `fix`.
