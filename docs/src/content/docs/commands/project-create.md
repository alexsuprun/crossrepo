---
title: xr project create
description: Make a project folder with a git worktree of each chosen repo on one branch, and run the post-create hook.
---

`xr project create` makes a project: one folder for one branch, with a git worktree of each repo you choose. Then it runs your `post-create` hook. When something fails, or you press Ctrl-C, it undoes everything, so nothing is left behind. The one thing that stays is a new local branch that tracks `origin/<branch>`, because its commits are on `origin`.

```sh
xr project create <branch> <repo>...
xr project create <branch> --all
xr project create <branch>
```

It works only in a codebase folder, or with `--codebase-path <path>`. In a project folder it fails with `not-a-codebase`.

## Arguments and options

| Argument or option | What it does |
| --- | --- |
| `<branch>` | The branch of the project. It is required. |
| `<repo>...` | The repos of the project, by their names in the config. The project gets them in config order, each one once. |
| `--all` | Use every repo of the config. A repo that is not on disk is an error, never skipped. |

You cannot give repo names and `--all` together. A branch name with `<`, `>`, `:`, `|`, `"`, `?` or `*` is a usage error on every OS, because Windows does not allow these characters in a folder name.

## Pick the repos

With no repo names and no `--all`, a picker "Pick the repos of the project" opens in a terminal. It lists the repos of the config that are on disk, in config order. Mark repos with Space and press Enter. You must mark at least one. Ctrl-C or Escape stops the command with `interrupted` (exit code 130), and nothing changes. The picker opens before the lock is taken.

The picker opens only when stdin and stdout are a terminal, and neither `--json` nor `--no-interactive` is given. Otherwise the command fails with `missing-argument`, and the message lists the repos. With `--json`, `error.details` is `{ "argument": "repos", "choices": ["api", "web"] }`. When no repo is on disk, the command fails with `There is no repo on disk to put in a project.` and the hint `xr codebase clone`, in every mode.

## Folder layout

The project folder is `<projects-dir>/<branch-slug>/`. The slug is the branch with each `/` replaced by `--`, so the branch `feat/login` gets the folder `feat--login`. `projects-dir` is `.projects` in the codebase by default. When `projects-dir` does not exist, `xr` makes it, with any missing parent folders.

```text
.projects/feat--login/
  .crossrepo/project.yaml
  AGENTS.md
  api/
  web/
```

Each repo folder is a git worktree of the repo in the codebase. `AGENTS.md` is a copy of the codebase `AGENTS.md` with the `## Codebase` and `## Repos` sections made for this project. `xr` never writes `CLAUDE.md` and never commits a file.

## Branch sources

For each repo, `xr` picks where the branch comes from, in this order:

| Source | When | What happens |
| --- | --- | --- |
| `local` | The repo has a local branch with this name. | The worktree checks out that branch. |
| `tracking` | Only `origin/<branch>` exists. | A new local branch that tracks `origin/<branch>`. |
| `new` | Neither exists. | A new branch from `origin/<default-branch>`, with no upstream, so a plain `git push` never goes to the default branch. |

The default branch is `default-branch` of the repo in the config, else the branch that `origin/HEAD` points to.

## Checks first

The command takes the codebase lock, `.crossrepo/xr.lock`, then checks everything before it changes anything. When a check fails, nothing changes.

1. The project folder must not exist. Any folder at that path counts, also one with the same slug from another branch (`feat--x` and `feat/x`), or one that differs only in case on a file system that ignores case.
2. `git fetch origin` runs in each repo, with one step line each. A failed fetch fails the command.
3. Each repo must have a default branch.
4. The branch must not be checked out in the codebase repo or in any other worktree of the repo. `xr` never uses `git worktree add --force`.
5. When `post-create` is set, `sh` must be found.

Ctrl-C during these checks changes nothing and exits with code 130.

## Steps

1. Make project folder: makes `projects-dir` with any missing parents, then the project folder.
2. Add worktree `<repo>`: one step per repo, in config order.
3. Write project record: `.crossrepo/project.yaml`.
4. Write AGENTS.md.
5. One step for each `post-create` line.

## The project record

`.crossrepo/project.yaml` has these keys, in this order:

```yaml
branch: feat/login
codebase: /home/me/shop
repos:
  - api
  - web
created: 2026-10-20T14:03:12Z
```

`codebase` is the absolute path of the codebase in the form of your OS. `repos` is in config order. `created` is the time in UTC, to the second.

## post-create

`project.post-create` in the config is a list of shell lines. `xr` runs each line with its own `sh -c`, in order, in the project folder, with stdin closed. It stops at the first line that fails. The output of each line goes to stderr as it comes, also with `--json`, and each line has one step line `post-create: <command>`, cut to 60 characters.

```yaml
project:
  post-create:
    - cp "$CROSSREPO_CODEBASE_PATH/api/.env" api/
    - make setup
  vars:
    PORT: 5432
    DEBUG: true
```

A line that exits with a code other than 0 fails with `hook-failed`. A line that runs for more than 10 minutes is stopped and fails with `hook-failed` and the message "timed out after 10 minutes". On Ctrl-C or a timeout, `xr` stops the line and every process it started.

On macOS and Linux, `xr` uses `/bin/sh`. On Windows, it finds `git.exe` on `PATH` and uses the `sh.exe` of Git for Windows. Without it, the command fails with `sh-not-found` before it changes anything.

### Variables

Each line gets the environment of `xr`, then the values of `project.vars`, then these 7 variables. A later name wins, so the 7 variables always win. On Windows, names match with case ignored.

| Variable | Value |
| --- | --- |
| `CROSSREPO_CODEBASE_PATH` | The codebase folder. |
| `CROSSREPO_CODEBASE_NAME` | `name` from the config, else the codebase folder name. |
| `CROSSREPO_PROJECT_PATH` | The project folder. |
| `CROSSREPO_PROJECT_NAME` | The project folder name, the slug. |
| `CROSSREPO_PROJECT_BRANCH` | The branch. |
| `CROSSREPO_PROJECT_REPOS` | The repos of the project, one per line, in record order. |
| `CROSSREPO_HOOK` | The hook that runs: `post-create` here, and `pre-remove` in [`xr project remove`](../project-remove/). |

A `project.vars` value can be text, a number or a boolean. A number or a boolean is passed as text: `5432` becomes `"5432"` and `true` becomes `"true"`. A list or a map is `invalid-config`.

A `project.vars` name may not start with `CROSSREPO_`, in any case, since these names belong to `xr`. With such a name, the command fails with `reserved-var-name` before it opens a picker or changes anything. [`xr codebase doctor`](../codebase-doctor/) lists each such name with its file.

## Undo

When a step fails, or you press Ctrl-C, `xr` undoes the steps that are done, in reverse order, so the project folder goes last:

- Each worktree is removed with `git worktree remove --force`.
- A branch that the command made from the default branch is deleted with `git branch -D`. A branch that existed before, local or on `origin`, is never deleted. A new branch that tracks `origin/<branch>` stays, because its commits are on `origin`.
- The record and `AGENTS.md` are removed.
- The project folder is removed, and the `projects-dir` folders that this run made.

Undo never runs a hook. What a hook made outside the project folder stays. When an undo fails, the other undos still run, and `error.details.leftovers` lists each thing left with the command to remove it by hand.

## Output

stderr gets one line for each check and step, and the hook output. stdout gets the project path (relative to the codebase or `~`), the branch, and one line per repo:

```text
.projects/feat--login

feat/login

✓ api: new branch from origin/main
✓ web: local branch
```

## JSON

With `--json`, stdout is one JSON object. `project` is the absolute path. Each repo has `source`: `local`, `tracking` or `new`.

```json
{
  "ok": true,
  "warnings": [],
  "project": "/home/me/shop/.projects/feat--login",
  "branch": "feat/login",
  "repos": [
    { "repo": "api", "status": "ok", "message": "new branch from origin/main", "source": "new" },
    { "repo": "web", "status": "ok", "message": "local branch", "source": "local" }
  ]
}
```

## Errors

| Code | When |
| --- | --- |
| `usage` | No branch, a branch with one of the characters in [Arguments and options](#arguments-and-options), or repo names together with `--all`. Nothing changes. The exit code is 2. |
| `missing-argument` | No repo names and no `--all`, and no picker can open, or no repo is on disk. `error.details` is `{ "argument": "repos", "choices": [<name>] }`. The exit code is 2. |
| `not-a-codebase` | The folder is not a codebase. A project folder is not accepted either. |
| `invalid-config` | The config is not valid, for example a `project.vars` value is a list or a map. |
| `reserved-var-name` | A `project.vars` name starts with `CROSSREPO_`, in any case. The message names each such name and the config file that sets it. The hint is `xr codebase doctor`. It comes first, before the picker: no lock, no change. |
| `repo-not-found` | A repo name is not in the config. The hint names `xr codebase repo list`. |
| `repos-not-ready` | A chosen repo is not on disk, also with `--all`. `error.details.repos` has one row per repo. The hint names `xr codebase clone`. |
| `project-exists` | The project folder exists. `error.details.path` is the path. |
| `git-failed` | A git command failed, for example the fetch or the worktree add. |
| `no-default-branch` | A repo has no `default-branch` in the config and no `origin/HEAD`, or the branch must start from `origin/<default-branch>` and the repo has no such branch. The hint is `git -C "<repo>" remote set-head origin --auto`. |
| `branch-in-use` | The branch is checked out in the codebase repo or in another worktree. `error.details` is `{ "repo", "path" }`. When that worktree folder was deleted by hand, the hint is `git -C "<repo>" worktree prune`. |
| `sh-not-found` | `post-create` is set, and Windows has no Git for Windows `sh.exe`. Install Git for Windows. |
| `hook-failed` | A `post-create` line failed or timed out. The message has the line and its exit code. `error.details` has `command`, `exitCode`, `timedOut` and `hookOutput.lines`, the last 20 lines of its output. Everything is undone. |
| `git-too-old` | git is older than 2.27. |
| `lock-held` | Another `xr` command holds the lock of this codebase. Nothing changes. |
| `interrupted` | You pressed Ctrl-C, or Ctrl-C or Escape in the picker. Everything is undone. The exit code is 130. |

See [Output and errors](../../output/) for the exit codes.
