---
title: Hooks
description: Run your own shell commands after a project is created and before it is removed.
---

Hooks are your own shell commands that `xr` runs for a project. Use them to copy `.env` files, install dependencies, or stop a remove that would lose work. crossrepo has no built-in actions: each thing a hook does is a line that you write.

## The two hooks

Both hooks are lists under `project:` in the config, at any [config level](../config/#three-levels).

| Hook | Runs | When a line fails |
| --- | --- | --- |
| `project.post-create` | At the end of [xr project create](../../commands/project-create/), after the worktrees, the project record and `AGENTS.md` are written. | The create is undone. See [When a hook fails](#when-a-hook-fails). |
| `project.pre-remove` | In [xr project remove](../../commands/project-remove/), after its checks and before anything is deleted. | The remove stops, and the project stays as it is. |

```yaml
project:
  post-create:
    - npm --prefix api ci
    - cp "$CROSSREPO_CODEBASE_PATH/web/.env" web/
  pre-remove:
    - echo "Removing $CROSSREPO_PROJECT_NAME"
```

A list in a later config level replaces the whole list of an earlier level. So `post-create: []` in your `config.local.yaml` turns the codebase hook off on your machine. Run [xr config show](../../commands/config-show/) to see the hook lines that `xr` will run and the file that gives them.

## How a hook runs

- Each list item is one line. A line can have many commands, or many text lines with a YAML `|` block.
- Each line runs with `sh -c`: `/bin/sh` on macOS, Linux and WSL, and the `sh.exe` of [Git for Windows](https://gitforwindows.org) on native Windows.
- The lines run one at a time, in list order. The first line that fails stops the hook, and the lines after it do not run.
- A hook runs once per project, not once per repo. To do something in each repo, loop over `$CROSSREPO_PROJECT_REPOS`.
- The current folder is the project folder, such as `~/work/acme/.projects/feat--login`.
- stdin is closed, so a line cannot ask questions.
- The output of each line, stdout and stderr, goes to the stderr of `xr`. This is also true with `--json`, so stdout keeps one JSON object.
- Each line can run for 10 minutes. After that, `xr` stops the line and every process it started, and the line fails.
- Ctrl-C also stops the line and every process it started.

Each line prints a step line such as `✓ post-create: npm --prefix api ci`, with the first text line of the command, cut at 60 characters.

On native Windows, when a hook has lines and `xr` finds no `sh.exe`, the command fails with `sh-not-found` before it changes anything.

## Built-in variables

Each line gets your environment plus these 7 variables:

| Variable | Value |
| --- | --- |
| `CROSSREPO_CODEBASE_PATH` | The codebase folder. |
| `CROSSREPO_CODEBASE_NAME` | The `name` from the config, else the codebase folder name. |
| `CROSSREPO_PROJECT_PATH` | The project folder. |
| `CROSSREPO_PROJECT_NAME` | The project folder name, such as `feat--login`. |
| `CROSSREPO_PROJECT_BRANCH` | The branch, such as `feat/login`. |
| `CROSSREPO_PROJECT_REPOS` | The repos of the project, one per line. |
| `CROSSREPO_HOOK` | The hook that runs: `post-create` or `pre-remove`. |

The folder of a repo in the codebase is `$CROSSREPO_CODEBASE_PATH/<repo>`, and its worktree is `$CROSSREPO_PROJECT_PATH/<repo>`.

## Your own variables

`project.vars` gives your own variables to every hook line:

```yaml
project:
  vars:
    PORT: 3000
    DB_NAME: app
  post-create:
    - echo "PORT=$PORT" > api/.env
    - createdb "${DB_NAME}_$CROSSREPO_PROJECT_NAME"
```

- Each name is used exactly as written.
- Each value is plain text. A number or a boolean becomes text, so `3000` is `"3000"` and `true` is `"true"`. YAML reads some values as numbers first, so `1.10` becomes `"1.1"` and `0x10` becomes `"16"`. Quote a value that must stay as written, such as `VERSION: "1.10"`. There are no templates: to combine values, use the shell, as in `"${DB_NAME}_$CROSSREPO_PROJECT_NAME"`.
- `project.vars` is a map, so it merges key by key across the config levels. A later level wins for the same name.
- A `project.vars` value wins over a variable of the same name in your environment.
- A name that starts with `CROSSREPO_`, in any case, such as `crossrepo_port`, is the error `reserved-var-name`. `xr project create` and `xr project remove` then stop before they change anything, and the message names each name and its config file. [xr codebase doctor](../../commands/codebase-doctor/) reports it too.
- The values come only from the config. One hook line cannot pass a value to the next one.

## When a hook fails

A line fails when it exits with a code that is not 0, when a signal stops it, or when it runs for more than 10 minutes. Then `xr` fails with `hook-failed` and exit code 1. The error has the line, its exit code, and the last 20 lines of its output.

```text
post-create: cp "$CROSSREPO_CODEBASE_PATH/web/.env" web/…
cp: ~/work/acme/web/.env: No such file or directory
✗ post-create: cp "$CROSSREPO_CODEBASE_PATH/web/.env" web/
error: The post-create hook `cp "$CROSSREPO_CODEBASE_PATH/web/.env" web/` failed with exit code 1.
Fix the line in `project.post-create` of the config, then run the command again.

Hook output
  cp: ~/work/acme/web/.env: No such file or directory
```

With `--json`, `error.details` has `command`, `exitCode`, `timedOut` and `hookOutput.lines`. See [Output and errors](../../output/).

**post-create.** `xr` undoes the create: it removes the worktrees and the project folder, and deletes each branch that this create made new. A branch that existed before stays. `xr` does not undo what the hook lines did, for example a file written or a database made outside the project folder. `pre-remove` does not run during this undo.

**pre-remove.** The remove stops before anything is deleted. The worktrees, the project folder and the branches stay. `--force` does not skip `pre-remove`: it skips only the check for uncommitted changes. Fix the line or the problem it found, then run `xr project remove` again.

## Examples

These two examples are based on the commented-out examples in the config that `xr codebase init` writes.

Copy untracked files, such as `.env`, from each repo into its new worktree:

```yaml
project:
  post-create:
    - |
      printf '%s\n' "$CROSSREPO_PROJECT_REPOS" | while read -r repo; do
        cp "$CROSSREPO_CODEBASE_PATH/$repo/.env" "$CROSSREPO_PROJECT_PATH/$repo/" 2>/dev/null || true
      done
```

Stop the remove when a worktree has commits that are not pushed. A new project branch has no upstream until you push it with `git push -u`, so a branch with no upstream also stops the remove:

```yaml
project:
  pre-remove:
    - |
      printf '%s\n' "$CROSSREPO_PROJECT_REPOS" | while read -r repo; do
        dir="$CROSSREPO_PROJECT_PATH/$repo"
        if ! git -C "$dir" rev-parse -q --verify '@{upstream}' >/dev/null; then
          echo "$repo has no upstream branch"; exit 1
        fi
        if [ -n "$(git -C "$dir" log '@{upstream}..' --oneline)" ]; then
          echo "$repo has unpushed commits"; exit 1
        fi
      done
```

## Security

Hooks run as you, with your permissions, and there is no trust step. A codebase config that is kept in git runs its hooks on the machine of every teammate who uses it. Before your first `xr project create` in a codebase from someone else, read its hooks with [xr config show](../../commands/config-show/). See the [security policy](https://github.com/alexsuprun/crossrepo/blob/master/SECURITY.md).
