---
title: Hooks
description: Run your own shell commands before and after a project is created or removed, or repos are added to it or removed from it.
---

Hooks are your own shell commands that `xr` runs for a project. Use them to check that a tool is installed, copy `.env` files, install dependencies, stop a remove that would lose work, or clean up after a remove. crossrepo has no built-in actions: each thing a hook does is a line that you write.

## The hooks

crossrepo has 8 hooks. All are lists under `project:` in the config, at any [config level](../config/#three-levels). The rule is: `pre-` hooks check, `post-` hooks do the work. A `pre-` hook runs before the command makes or removes anything, so a failed line stops the command and nothing is made or removed. A `post-` hook runs when the main work is done.

| Hook | Runs | Folder | When a line fails |
| --- | --- | --- | --- |
| `project.pre-create` | In [xr project create](../../commands/project-create/), after its checks and before it makes the project folder. | The codebase folder | The create stops, and nothing is made. |
| `project.post-create` | At the end of [xr project create](../../commands/project-create/), after the worktrees, the project record and `AGENTS.md` are written. | The project folder | The create is undone. See [When a hook fails](#when-a-hook-fails). |
| `project.pre-remove` | In [xr project remove](../../commands/project-remove/), after its checks and before anything is deleted. | The project folder | The remove stops, and the project stays as it is. |
| `project.post-remove` | At the end of [xr project remove](../../commands/project-remove/), after the worktrees, the branches (with `--delete-branch`) and the project folder are removed. | The codebase folder | A warning. The remove still succeeds, with exit code 0. |
| `project.pre-repo-add` | In [xr project repo add](../../commands/project-repo-add/), after its checks and before it adds a worktree. | The project folder | The add stops, and nothing is made. |
| `project.post-repo-add` | At the end of [xr project repo add](../../commands/project-repo-add/), after the worktrees, the project record and `AGENTS.md` are written. | The project folder | The add is undone. |
| `project.pre-repo-remove` | In [xr project repo remove](../../commands/project-repo-remove/), after its checks and before anything is deleted. | The project folder | The remove stops, and the repos stay. |
| `project.post-repo-remove` | At the end of [xr project repo remove](../../commands/project-repo-remove/), after the worktrees, the branches (with `--delete-branch`), the record and `AGENTS.md` are done. | The project folder | A warning. The remove still succeeds, with exit code 0. |

```yaml
project:
  pre-create:
    - command -v npm >/dev/null || { echo "npm is not installed"; exit 1; }
  post-create:
    - npm --prefix api ci
    - cp "$CROSSREPO_CODEBASE_PATH/web/.env" web/
  pre-remove:
    - echo "Removing $CROSSREPO_PROJECT_NAME"
  post-remove:
    - tmux kill-session -t "$CROSSREPO_PROJECT_NAME" 2>/dev/null || true
```

Use `pre-create` to check tools or names before `xr` makes anything. Use `post-remove` for cleanup that could stop the remove if it ran in `pre-remove`, for example to close the terminal or the cmux workspace that runs `xr`. Use `pre-repo-remove` to save files that git ignores, such as an `ai-docs` folder, before their worktree is deleted: the check for uncommitted changes skips ignored files.

`xr project create` and `xr project remove` run only the create and remove hooks; `xr project repo add` and `xr project repo remove` run only the repo hooks. `xr project sync` and `xr codebase repo remove` run none.

A list in a later config level replaces the whole list of an earlier level. So `post-create: []` in your `config.local.yaml` turns the codebase hook off on your machine. Run [xr config show](../../commands/config-show/) to see the hook lines that `xr` will run and the file that gives them.

## How a hook runs

- Each list item is one line. A line can have many commands, or many text lines with a YAML `|` block.
- Each line runs with `sh -c`: `/bin/sh` on macOS, Linux and WSL, and the `sh.exe` of [Git for Windows](https://gitforwindows.org) on native Windows.
- The lines run one at a time, in list order. The first line that fails stops the hook, and the lines after it do not run.
- A hook runs once per command, not once per repo. To do something in each repo, loop over `$CROSSREPO_REPOS` or `$CROSSREPO_PROJECT_REPOS`.
- The current folder is the project folder, such as `~/work/acme/.projects/feat--login`, for `post-create`, `pre-remove` and the 4 repo hooks. For `pre-create` and `post-remove`, the project folder does not exist, so the current folder is the codebase folder, such as `~/work/acme`.
- stdin is closed, so a line cannot ask questions.
- The output of each line, stdout and stderr, goes to the stderr of `xr`. This is also true with `--json`, so stdout keeps one JSON object.
- Each line can run for 10 minutes. After that, `xr` stops the line and every process it started, and the line fails.
- Ctrl-C also stops the line and every process it started.

Each line prints a step line such as `✓ post-create: npm --prefix api ci`, with the first text line of the command, cut at 60 characters.

`xr` looks for `sh` before it changes anything, when either hook of the command has lines: `pre-create` or `post-create` for `xr project create`, `pre-remove` or `post-remove` for `xr project remove`, `pre-repo-add` or `post-repo-add` for `xr project repo add`, and `pre-repo-remove` or `post-repo-remove` for `xr project repo remove`. On native Windows with no `sh.exe`, the command then fails with `sh-not-found`, and nothing changes.

## Built-in variables

Each line gets your environment plus these 8 variables:

| Variable | Value |
| --- | --- |
| `CROSSREPO_CODEBASE_PATH` | The codebase folder. |
| `CROSSREPO_CODEBASE_NAME` | The `name` from the config, else the codebase folder name. |
| `CROSSREPO_PROJECT_PATH` | The project folder. In `pre-create` it is the folder that `xr` will make, and it does not exist yet. In `post-remove` it is the folder that was just removed. |
| `CROSSREPO_PROJECT_NAME` | The project folder name, such as `feat--login`. |
| `CROSSREPO_PROJECT_BRANCH` | The branch, such as `feat/login`. |
| `CROSSREPO_PROJECT_REPOS` | The repos of the project, one per line, in record order. These include the repos with `always: true` that `xr project create` added, see [Repos in every project](../../commands/project-create/#repos-in-every-project). In the repo hooks, it is the repos at that moment: before the change in `pre-repo-add` and `pre-repo-remove`, after it in `post-repo-add` and `post-repo-remove`. |
| `CROSSREPO_REPOS` | The repos that the command adds or removes, one per line. In the create and remove hooks, it is the same as `CROSSREPO_PROJECT_REPOS`. |
| `CROSSREPO_HOOK` | The hook that runs, such as `pre-create` or `post-repo-remove`. |

The folder of a repo in the codebase is `$CROSSREPO_CODEBASE_PATH/<repo>`, and its worktree is `$CROSSREPO_PROJECT_PATH/<repo>`. In `pre-create` and `post-remove`, the worktrees do not exist.

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
- A name that starts with `CROSSREPO_`, in any case, such as `crossrepo_port`, is the error `reserved-var-name`. `xr project create`, `xr project remove`, `xr project repo add` and `xr project repo remove` then stop before they change anything, and the message names each name and its config file. [xr codebase doctor](../../commands/codebase-doctor/) reports it too.
- The values come only from the config. One hook line cannot pass a value to the next one.

## When a hook fails

A line fails when it exits with a code that is not 0, when a signal stops it, or when it runs for more than 10 minutes. The lines after it do not run. For every hook but `post-remove` and `post-repo-remove`, `xr` then fails with `hook-failed` and exit code 1. The error has the line, its exit code, and the last 20 lines of its output.

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

**pre-create.** The create stops before it makes anything. No folder, worktree, branch or record is made. When a create check fails first, for example with `project-exists`, `pre-create` does not run.

**post-create.** `xr` undoes the create: it removes the worktrees and the project folder, and deletes each branch that this create made new. A branch that existed before stays. `xr` does not undo what the hook lines did, for example a file written or a database made outside the project folder. Undo never runs a hook, so `pre-remove` and `post-remove` do not run during this undo.

**pre-remove.** The remove stops before anything is deleted. The worktrees, the project folder and the branches stay. `--force` does not skip `pre-remove`: it skips only the check for uncommitted changes. Fix the line or the problem it found, then run `xr project remove` again.

**post-remove.** The project is already gone, so nothing can be undone. A failed line does not fail the command: the exit code is 0, and stderr gets a warning with the hint and the last 20 lines of the output:

```text
! The post-remove hook `tmux kill-session -t "$CROSSREPO_PROJECT_NAME"` failed with exit code 1.
  The project is removed. Fix the line in `project.post-remove`, then run by hand the lines that did not run: `tmux kill-session -t "$CROSSREPO_PROJECT_NAME"`.
    can't find session: feat--login
```

With `--json`, the same warning is in `warnings`, with `code` `hook-failed`, `message`, `hint`, and `lines`, the last 20 lines of the output when the line printed any. The hint names the failed line and every line after it, so you can run them by hand. Ctrl-C during `post-remove` works the same way: the running line stops, the lines after it do not run, and the command prints the `hook-failed` warning and exits with code 0. Its message is "The post-remove hook `<line>` was stopped by Ctrl-C.", and its hint is "The project is removed. Run by hand the lines that did not run, if they are needed:" with the same list of lines. A second Ctrl-C stops `xr` at once. When a remove step fails, or `pre-remove` fails, `post-remove` does not run.

**pre-repo-add and pre-repo-remove.** The command stops before it changes anything. A failed check, such as `repo-already-in-project` or `uncommitted-changes`, comes first, and then the hook does not run. `--force` does not skip `pre-repo-remove`.

**post-repo-add.** `xr` undoes the add, as for `post-create`: the new worktrees are removed, a branch that the command made is deleted, and the record and `AGENTS.md` get their old text back. `xr` does not undo what the hook lines did. Undo never runs a hook.

**post-repo-remove.** Works as `post-remove`: a warning, exit code 0. The hint starts with "The repo web is removed." or "The repos web, docs are removed." instead of "The project is removed.". When a remove step fails, or `pre-repo-remove` fails, `post-repo-remove` does not run.

## Examples

The config that `xr codebase init` writes has commented-out examples for the 4 create and remove hooks, the first 4 below. The `pre-repo-remove` example is not in it.

Stop the create before it changes anything when a tool is missing:

```yaml
project:
  pre-create:
    - command -v node >/dev/null || { echo "node is not installed"; exit 1; }
```

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

Clean up outside the project folder after it is removed, such as a tmux session with the name of the project:

```yaml
project:
  post-remove:
    - tmux kill-session -t "$CROSSREPO_PROJECT_NAME" 2>/dev/null || true
```

Save an ignored folder, such as `ai-docs`, out of each worktree before `xr project repo remove` deletes it:

```yaml
project:
  pre-repo-remove:
    - |
      saved="$CROSSREPO_CODEBASE_PATH/.saved/$CROSSREPO_PROJECT_NAME"
      stamp="$(date +%Y%m%d-%H%M%S)"
      printf '%s\n' "$CROSSREPO_REPOS" | while read -r repo; do
        if [ -d "$repo/ai-docs" ]; then
          mkdir -p "$saved"
          mv "$repo/ai-docs" "$saved/$repo-ai-docs-$stamp"
        fi
      done
```

## Security

Hooks run as you, with your permissions, and there is no trust step. A codebase config that is kept in git runs its hooks on the machine of every teammate who uses it. Before your first `xr project create` in a codebase from someone else, read its hooks with [xr config show](../../commands/config-show/). See the [security policy](https://github.com/alexsuprun/crossrepo/blob/master/SECURITY.md).
