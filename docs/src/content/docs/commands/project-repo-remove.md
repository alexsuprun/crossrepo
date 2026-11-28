---
title: xr project repo remove
description: Remove the worktree of one or more repos from a live project, keep the branches, and never lose uncommitted work by mistake.
---

`xr project repo remove` takes repos out of a project. It removes the git worktree of each repo, then writes the project record and the project `AGENTS.md` without them. The project and its other repos stay. It keeps the branches, unless you give `--delete-branch`.

```sh
xr project repo remove <repo>...
xr project repo remove <repo>... --project <project>
xr project repo remove <repo>... --force
xr project repo remove <repo>... --delete-branch
xr project repo remove
```

The project is found the same way as in [xr project repo add](../project-repo-add/#which-project): `--project <project>` first, else the current project folder, else a picker in a codebase folder. A project record that is not valid is an error `invalid-project-record` for the current project folder, and for the chosen project when its record is read again inside the lock. The record of another project that is not valid is a warning `invalid-project-record`, and that project is skipped.

## Arguments and options

| Argument or option | What it does |
| --- | --- |
| `<repo>...` | The repos to remove, by their names in the project record. A name given twice counts once. The repos are removed in record order. |
| `--project <project>` | The project to change: its folder name or its branch. It wins over the current project. |
| `--force` | Remove the worktrees even when they have uncommitted changes. It skips only that check, and it never deletes an unmerged branch. |
| `--delete-branch` | After the worktrees are removed, delete the branch of each repo with `git branch -d`. A branch that is not merged stays. |

## Pick the repos

With no `<repo>`, a multi-select picker "Pick the repos to remove" opens in a terminal. It lists the repos of the project, in record order. Not in a terminal, or with `--json` or `--no-interactive`, the command fails with `missing-argument`, and `error.details` is `{ "argument": "repos", "choices": [<repo>] }`. The pickers open before the lock is taken.

## Checks first

The command takes the codebase lock, then runs these checks. None of them changes anything.

1. Each repo is in the project, else `repo-not-found` with the hint `xr project repo list`.
2. At least one repo stays in the project, else `last-repo`. To remove the whole project, use [xr project remove](../project-remove/).
3. In each worktree folder that exists, no changed, staged or untracked file that git does not ignore, else `uncommitted-changes`. The hint names the command with `--force`. Commits that are not pushed, stashes and ignored files do not count. `--force` skips this check.
4. When `pre-repo-remove` or `post-repo-remove` is set, `sh` must be found, else `sh-not-found`.
5. The `pre-repo-remove` hook runs in the project folder, while the worktrees still exist. A failed line stops the command with `hook-failed`, and nothing changes. `--force` does not skip it.

A worktree folder that is missing, for example one you deleted by hand, is not a failure. Other folders in the project folder are not checked. The command runs `pre-repo-remove` and `post-repo-remove`, not `pre-remove` or `post-remove`. See the [hooks guide](../../guides/hooks/).

## Steps

When every check passes, the delete phase runs these steps in this order:

1. **Remove worktree `<repo>`**, one step per repo: `git worktree remove --force`. When the worktree folder is missing, the step runs `git worktree prune` instead, and its step line says `(worktree folder missing)`.
2. **Delete branch `<repo>`**, one step per repo, only with `--delete-branch`: `git branch -d <branch>`, never `-D`. An unmerged branch stays, with the warning `branch-not-merged`.
3. **Write project record**: the record without these repos. The `created` time stays.
4. **Write AGENTS.md**: only the `## Codebase` and `## Repos` sections of the project `AGENTS.md` change.
5. One step for each `post-repo-remove` line, in the project folder. A failed or stopped line is a `hook-failed` warning, and the exit code stays 0. When an earlier step fails, `post-repo-remove` does not run.

So the record changes only after the worktrees are gone. These steps have no undo. When a step fails, the command stops, and `error.details.leftovers` lists the step that failed and every step that did not run, each with the command to finish it by hand. When you press Ctrl-C during these steps, the running step ends first, then the command stops with the leftovers and exits with code 130.

### Remove the current folder

When `xr` runs in a worktree folder that the command removes, or in a folder inside it, `xr` moves its own current folder to the project folder before the delete phase. Use `--codebase-path <project folder>` there, because `xr` does not look at parent folders. The output ends with the note ``Your shell is in a deleted folder. Run `cd <project folder>`.``

## Output

stdout gets the project path, the branch, and one line per removed repo, with the same messages as [xr project remove](../project-remove/#output):

```text
.projects/feat--login

feat/login

✓ web: worktree removed, branch kept
```

## JSON

```json
{
  "ok": true,
  "warnings": [],
  "project": "/home/me/shop/.projects/feat--login",
  "branch": "feat/login",
  "repos": [
    { "repo": "web", "status": "ok", "message": "worktree removed, branch kept", "branchDeleted": false }
  ]
}
```

A repo with an unmerged branch has `hint`, the `git branch -D` command. `notes` is there only when `xr` ran in a removed folder.

## Errors

| Code | When |
| --- | --- |
| `missing-argument` | No project or no repo, and no picker can open. The exit code is 2. |
| `not-a-codebase` | The folder is not a codebase or a project folder. |
| `reserved-var-name` | A `project.vars` name starts with `CROSSREPO_`, in any case. The hint is `xr codebase doctor`. It comes first, before the pickers: no lock, no change. |
| `project-not-found` | No project has the name of `--project`, or the project record is gone by the time the lock is taken. Nothing changes. |
| `invalid-project-record` | The record of the current project folder is not valid, or the record of the chosen project is not valid when it is read again inside the lock. Nothing changes. For another project it is a warning, and that project is skipped. |
| `repo-not-found` | A repo is not in the project. Nothing changes. |
| `last-repo` | The command would remove every repo of the project. The hint is `xr project remove`. Nothing changes. |
| `uncommitted-changes` | A worktree has changed, staged or untracked files. `error.details.worktrees` lists each worktree as `{ "repo", "path", "files" }`. Nothing changes. |
| `sh-not-found` | `pre-repo-remove` or `post-repo-remove` is set, and Windows has no Git for Windows `sh.exe`. Nothing changes. |
| `hook-failed` | A `pre-repo-remove` line failed or timed out. `error.details` has `command`, `exitCode`, `timedOut` and `hookOutput.lines`. Nothing changes. |
| `git-failed` | A git command failed. In the delete phase, `error.details.leftovers` lists what is left. |
| `lock-held` | Another `xr` command holds the lock of this codebase. Nothing changes. |
| `interrupted` | You pressed Ctrl-C, or Ctrl-C or Escape in a picker. In the delete phase, `error.details.leftovers` lists what is left. The exit code is 130. |

Warning codes, in `warnings`:

| Code | When |
| --- | --- |
| `branch-not-merged` | `--delete-branch` kept a branch that git says is not merged. The hint has the `git branch -D` command. The exit code stays 0. |
| `invalid-project-record` | The record of another project is not valid. That project is skipped. |
| `hook-failed` | A `post-repo-remove` line failed, timed out, or was stopped by Ctrl-C. The repos are removed. The hint starts with "The repo web is removed." or "The repos web, docs are removed." and names the failed or stopped line and every line after it. `lines` has the last 20 lines of the output, when the line printed any. The exit code stays 0. |

See [Output and errors](../../output/) for the exit codes.
