---
name: xr
description: 'Runs the crossrepo CLI xr for the user and acts on its JSON result: calls every command with --json and --no-interactive, reads ok, error.code, repos, checks and leftovers, and handles error codes and merge conflicts of xr project sync. Use when the user asks to create, sync, remove, list or check a crossrepo project or codebase, or when an xr command failed. Triggers on "create a project for feat/x", "make a branch in all repos", "sync the project", "remove the project", "run xr doctor", "xr project create failed", "fix the sync conflict".'
license: MIT
---

# xr

Run `xr` (crossrepo) for the user, read its JSON result, and act on it without a guess.

## How to call xr

- Add `--json` and `--no-interactive` to every `xr` call, so `xr` never waits for input.
- For flags and arguments, read [references/commands.md](references/commands.md), which has the help text of each command. Never guess a flag.
- stdout is exactly one JSON object. Progress, hook output and live per-repo lines go to stderr.

## How to read the result

- `ok` is `true` or `false`. `warnings` is a list of `{code, message, hint}`; show each one to the user.
- When `ok` is `false`, `error` has `code`, `message`, `hint` and sometimes `details`. Show `message` and `hint` to the user.
- Branch on `error.code`, never on the exit number.
- Per-repo commands give `repos`: items `{repo, status, message, hint}`, where `status` is `ok`, `skipped`, `failed` or `conflict`. A conflict item also has `files`, and `stashKept` when the uncommitted changes stay in `git stash list`.
- Doctor commands give `checks`: items `{id, status, message, fix}`. Show each item that is not `ok` with its `fix`.
- `leftovers` items `{what, path, command}` list what an undo could not remove. Show them; run a `command` only with the user's yes.
- For error codes and the shape of each command's result, read [Output and errors](https://alexsuprun.github.io/crossrepo/output/).

## Missing arguments

On `missing-argument`, the command did not get a value it needs. When the user's request makes the choice clear, pick it from `error.details.choices` and run the command again with it. Otherwise ask the user and list those choices.

## Rules

- Never add `--force` or `--delete-branch` unless the user says yes to it in this conversation. Show what it would delete first.
- Never commit, push, stash or delete files to make an `xr` command pass, unless the user asks for it.

## Error codes

These codes need a special action. For any other code, show `message` and `hint` and ask the user how to go on.

| Code | Action |
| --- | --- |
| `uncommitted-changes` | Show each worktree in `error.details.worktrees` with its files. Ask the user to commit them, or to agree to `--force`. |
| `would-lose-work` | Show what would be lost. Ask the user before you add `--force`. |
| `lock-held` | Another `xr` command runs in this codebase. Wait for it to end, then try once more. Do not delete the lock file. |
| `project-drift` | Show `error.details.folders`. The user moves them out of the project folder. `--force` does not help. |
| `repos-failed` | Read `repos`. Show each `failed` or `conflict` repo with its message and hint. Run `xr project doctor --json --no-interactive` or `xr codebase doctor --json --no-interactive` when the cause is not clear. |
| `branch-in-use` | Show `error.details.repo` and `error.details.path`, where the branch is checked out. Let the user choose another branch or free that one. |
| `project-exists` | A folder is at `error.details.path` already. Show the hint and let the user choose. |
| `no-default-branch` | Show the hint, with the git command that sets `origin/HEAD`. Run it only with the user's yes. |
| `missing-argument` | See [Missing arguments](#missing-arguments). |

## Sync conflicts

`xr project sync` never fixes a conflict. Each conflicted repo has `status: conflict` and `files`, and the run fails with `repos-failed`. The path of a repo is in its hint, or is the project folder plus the repo name. For each such repo:

1. Show the user the `files`.
2. Fix the conflicts only with the user's agreement.
3. When `stashKept` is not set (a merge conflict), after the files are fixed:
   - `git -C <path> add <files>`
   - `GIT_EDITOR=true git -C <path> merge --continue`, so git opens no editor.
   - To stop instead, run `git -C <path> merge --abort`. The repo is then as it was before the merge.
4. When `stashKept` is `true` (the message says the changes stay in `git stash list`): the merge already passed, and git already put the changes back with conflict markers, so `git stash pop` does not work. After the files are fixed:
   - `git -C <path> reset`
   - Run `git -C <path> stash list` and find the entry with the message `autostash`. All worktrees of a repo share one stash list, so never drop another entry. When more than one entry has `autostash`, ask the user which one.
   - Show that entry to the user and ask. Only after a yes, run `git -C <path> stash drop <ref>`, with the ref of that entry, such as `stash@{0}`.
5. After a resolved merge (step 3 with `merge --continue`, or step 4), run `xr project sync --json --no-interactive` again. Do not run it after `merge --abort`: the same conflict comes back.
