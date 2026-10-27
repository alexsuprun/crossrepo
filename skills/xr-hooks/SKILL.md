---
name: xr-hooks
description: 'Writes crossrepo project hooks (pre-create, post-create, pre-remove, post-remove) and project.vars in the right crossrepo config file, as POSIX sh that needs no input, so the hook works on the first run. Reads the current config with xr config show first, asks which config level gets the hook, keeps comments and key order, and checks the result with xr codebase doctor. Use when the user wants xr to run a command when a project is created or removed, such as installing dependencies, copying .env files, or cleanup. Triggers on "add a post-create hook", "run npm ci after xr project create", "copy .env into each new project", "add a crossrepo hook", "clean up when a project is removed", "set a hook variable".'
license: MIT
---

# xr-hooks

Write crossrepo project hooks that work on the first run, in the config file the user picks.

## Rules

- Add `--json` and `--no-interactive` to every `xr` call. Branch on `error.code`, never on the exit number. For flags and arguments, read [references/commands.md](references/commands.md). For error codes, read [Output and errors](https://alexsuprun.github.io/crossrepo/output/). For all hook details, read the [hooks guide](https://alexsuprun.github.io/crossrepo/guides/hooks/).
- Save a hook only with the user's yes. Run a test only with the user's yes.
- Edit the config by hand. Keep every comment and the key order, and change only the keys of this hook. Never change a line the user did not agree to change.

## 1. Read the config

Run `xr config show --json --no-interactive`. Tell the user which hooks and `project.vars` exist already, and the file each one comes from.

## 2. Ask the level

| Level | File | Who gets the hook |
| --- | --- | --- |
| user | `~/.crossrepo/config.yaml` | This user, in every codebase. |
| codebase | `<codebase>/.crossrepo/config.yaml` | Everyone who uses this codebase config, often the team through git. |
| local | `<codebase>/.crossrepo/config.local.yaml` | This user, in this codebase only. |

- `xr` reads them in the order user, codebase, local, and a later level wins.
- A hook list in a later level replaces the whole list of an earlier level. `project.vars` merges name by name.
- When `xr config show` gives the same hook from a later level than the chosen one, the new lines never run. Tell the user before you save.
- A file can end in `.yml` instead. Edit the file that exists, and only the file of the chosen level.

## 3. Pick the hook

All 4 hooks are lists under `project:`. `pre-` hooks check, `post-` hooks do the work.

| Hook | Folder | Runs | When a line fails |
| --- | --- | --- | --- |
| `pre-create` | codebase folder | Before `xr project create` makes anything. | Nothing is made. |
| `post-create` | project folder | After the worktrees and `AGENTS.md` are made. | The whole create is undone. What the hook itself did is not undone. |
| `pre-remove` | project folder | Before `xr project remove` removes anything. | The project stays whole. `--force` does not skip this hook. |
| `post-remove` | codebase folder | After the project is removed. | Only a warning. |

- Only `xr project create` and `xr project remove` run hooks.
- Each list item is its own `sh -c`, in list order. The first line that fails stops the hook.
- stdin is closed, so a line cannot ask questions.
- Each line can run for 10 minutes, then it fails.
- The output goes to stderr.
- A hook runs once per project, not once per repo. To act in each repo, loop over `$CROSSREPO_PROJECT_REPOS`.

## 4. Use only these variables

- The 7 built-in vars: `CROSSREPO_HOOK`, `CROSSREPO_CODEBASE_PATH`, `CROSSREPO_CODEBASE_NAME`, `CROSSREPO_PROJECT_PATH`, `CROSSREPO_PROJECT_NAME`, `CROSSREPO_PROJECT_BRANCH`, `CROSSREPO_PROJECT_REPOS` (one repo per line).
- Each `project.vars` entry, under its exact name.
- In `pre-create` and `post-remove`, the project folder and the worktrees do not exist.
- Never give a `project.vars` entry a name that starts with `CROSSREPO_`, in any case. That is the error `reserved-var-name`.
- Give each `project.vars` entry a name that `sh` can use: `[A-Za-z_][A-Za-z0-9_]*`.
- Values are text. Quote a value that must stay as written, such as `VERSION: "1.10"`.

## 5. Write the lines

- Write POSIX `sh`, not Bash or PowerShell. On Windows, hooks run in the `sh` of Git for Windows.
- Quote every variable. Never use `read` or anything else that waits for input.
- A line that checks a tool exits with a code that is not 0 and prints why.
- Write a line as a quoted YAML string or a `|` block when it has a colon and a space (`: `), or a space and `#` (` #`), or it starts with a character that YAML gives a meaning, such as `[`, `{`, `&`, `*`, `!`, `|`, `>`, `%`, `@` or a quote. Otherwise the YAML breaks.

```yaml
project:
  vars:
    PORT: 3000
  pre-create:
    - command -v npm >/dev/null || { echo "npm is not installed" >&2; exit 1; }
  post-create:
    - |
      printf '%s\n' "$CROSSREPO_PROJECT_REPOS" | while IFS= read -r repo; do
        if [ -f "$CROSSREPO_CODEBASE_PATH/$repo/.env" ]; then
          cp "$CROSSREPO_CODEBASE_PATH/$repo/.env" "$repo/"
        fi
      done
```

The `read` in this loop reads the repo list from the pipe, not from stdin of `xr`, so it is safe.

## 6. Configs in git

When the chosen file is kept in git (check with `git ls-files`), tell the user: hooks run as each teammate who uses this config, with their rights, and with no trust step. `xr` does not ask before it runs a hook.

## 7. Finish

Run `xr codebase doctor --json --no-interactive`. Show each `reserved-var-name` and `unknown-config-key` item that is not `ok`, with its `fix`.

## 8. Offer a test

Offer a test, and run it only with the user's yes. Never run a hook in any other way.

1. `xr project create <test-branch> <repo> --json --no-interactive`, on a new test branch.
2. Only when the create result has `ok: true`: `xr project remove <project> --json --no-interactive`.

On `hook-failed`, show `error.details`: `command`, `exitCode`, `timedOut` and `hookOutput.lines`. After `xr project remove`, also read `warnings`: a failed `post-remove` line gives a `hook-failed` warning with `message`, `hint` and `lines`, and the remove still succeeds. The test branch stays after the remove. Delete it only with the user's yes.
