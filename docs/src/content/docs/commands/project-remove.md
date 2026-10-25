---
title: xr project remove
description: Remove the worktrees and the folder of a project after the pre-remove hook, keep the branches, and never lose uncommitted work by mistake.
---

`xr project remove` deletes a project when its work is done. It removes the git worktree of each repo and then the project folder. Before that, it checks that no uncommitted work would be lost and runs your `pre-remove` hook. It keeps the branches, unless you give `--delete-branch`.

```sh
xr project remove <project>
xr project remove <project> --force
xr project remove <project> --delete-branch
xr project remove
```

It works in a codebase folder or in a project folder, or with `--codebase-path <path>`. In any other folder it fails with `not-a-codebase`. `xr` does not look at parent folders, so in a folder inside the project folder, for example a worktree, you must give `--codebase-path <codebase>`.

## Arguments and options

| Argument or option | What it does |
| --- | --- |
| `<project>` | The project to remove: its folder name, such as `feat--login`, or its branch, such as `feat/login`. The folder name is tried first. |
| `--force` | Remove the worktrees even when they have uncommitted changes. It skips only that check. It never skips the drift check or the `pre-remove` hook, and it never deletes an unmerged branch. |
| `--delete-branch` | After each worktree is removed, delete its branch with `git branch -d`. A branch that is not merged stays. |

A project record that is not valid is a warning `invalid-project-record`, and that project is skipped. So the remove of another project goes on, and a project whose own record is not valid is not found (`project-not-found`).

## Pick a project

With no `<project>`, a picker "Pick the project to remove" opens in a terminal. It lists the project folder names of the codebase, in name order, with the branch of each one next to it. Pick one with the arrow keys and Enter. Ctrl-C or Escape in the picker stops the command with `interrupted` (exit code 130), and nothing changes. The picker opens before the lock is taken.

The picker opens only when stdin and stdout are a terminal, and neither `--json` nor `--no-interactive` is given. Otherwise the command fails with `missing-argument` and the message lists the projects. With `--json`, `error.details` is `{ "argument": "project", "choices": ["feat--login", "fix--bug"] }`. With no project in the codebase, the command fails with `missing-argument` and the message `There is no project in this codebase.` in every mode.

In a project folder too, `xr project remove` never takes the current project by itself. You must name it or pick it.

## Checks first

The command takes the codebase lock, `.crossrepo/xr.lock`, then runs these checks in this order. None of them changes anything. When a check fails, the project stays whole.

1. **Drift.** Each folder in the project folder must be a repo of the project record, or `.crossrepo`. Another folder, such as `notes/`, fails with `project-drift`, also with `--force`. Move that folder out of the project folder, then run the command again. Files, such as `AGENTS.md` or your own notes, are not drift. Folders whose name starts with `.`, such as `.idea`, `.vscode` or `.venv`, are not drift either: they are deleted with the project folder.
2. **Uncommitted changes.** In each worktree folder that exists, `git status` looks for changed, staged and untracked files that git does not ignore. Any such file fails with `uncommitted-changes`. The message lists each worktree with changes and at most 5 of its files. Commits that are not pushed, stashes and ignored files do not count. `--force` skips this check.
3. **sh.** When `pre-remove` is set, `sh` must be found, else `sh-not-found`.
4. **pre-remove.** The `pre-remove` hook runs. A failed line stops the command with `hook-failed`, and the project stays whole.

A worktree folder that is missing, for example one you deleted by hand, is not a failure. A worktree that is on another branch than the project record is not a failure either, and the uncommitted check still runs on it.

Ctrl-C during the checks, also while the hook runs, stops the hook and every process it started, changes nothing, and exits with code 130.

## pre-remove

`project.pre-remove` in the config is a list of shell lines. It works the same as [post-create](../project-create/#post-create): each line runs with its own `sh -c`, in order, in the project folder, with stdin closed, with one step line `pre-remove: <command>` each. It stops at the first line that fails, and a line may run for 10 minutes. Its output goes to stderr, also with `--json`.

```yaml
project:
  pre-remove:
    - docker compose down
```

Each line gets the same variables as `post-create`, with `CROSSREPO_HOOK` set to `pre-remove`. An `xr` command that changes files, started from the hook, fails with `lock-held`, because this command holds the lock.

## Steps

When every check passes, the delete phase runs these steps in this order:

1. **Remove worktree `<repo>`**, one step per repo, in record order: `git worktree remove --force`. This is safe, because the check phase found no uncommitted changes, or you gave `--force`. When the worktree folder is missing, the step runs `git worktree prune` in that repo instead, and its step line says `(worktree folder missing)`.
2. **Delete branch `<repo>`**, one step per repo, only with `--delete-branch`: `git branch -d <branch>` in the codebase repo, never `-D`, also with `--force`. When git refuses because the branch is not merged, the branch stays, the warning `branch-not-merged` has the `git branch -D` command to delete it anyway, and the remove goes on. When the repo has no local branch of that name any more, nothing is deleted.
3. **Remove project folder**: deletes the project folder with the record and `AGENTS.md`, last.

Without `--delete-branch`, no branch is deleted. These steps have no undo. When a step fails, the command stops, and `error.details.leftovers` lists the step that failed and every step that did not run, each with the command to finish it by hand. When you press Ctrl-C during these steps, the running step ends first, then the command stops, lists the leftovers the same way, and exits with code 130. Undo never runs a hook.

### Remove the current folder

When `xr` runs in the project folder, or in a folder inside it, `xr` moves its own current folder to the codebase before the delete phase, so the delete also works on Windows. In a folder inside the project folder, such as a worktree, run the command with `--codebase-path <codebase>`. Your shell stays in the deleted folder, so the output ends with the note ``Your shell is in a deleted folder. Run `cd <codebase>`.`` In text, the codebase path is relative to `~` when it is in your home folder, else absolute. In JSON it is absolute.

## Output

stderr gets one line for each step, the hook output, and the warnings. stdout gets the project path (relative to the codebase or `~`), the branch, and one line per repo:

```text
.projects/feat--login

feat/login

✓ api: worktree removed, branch deleted
✓ web: worktree removed, branch kept: not merged
  git -C "/home/me/shop/web" branch -D feat/login
```

The message of each repo is one of:

- `worktree removed, branch kept`
- `worktree removed, branch deleted`
- `worktree removed, branch kept: not merged`
- `worktree removed, branch already gone`
- `worktree folder missing, git entry pruned`, with `, branch deleted` and the other branch results added when you give `--delete-branch`

## JSON

With `--json`, stdout is one JSON object. `project` is the absolute path. Each repo has `branchDeleted`, which is `true` only when the branch was deleted. A repo with an unmerged branch has `hint`. `notes` is there only when `xr` ran in the removed folder.

```json
{
  "ok": true,
  "warnings": [
    {
      "code": "branch-not-merged",
      "message": "The branch feat/login of /home/me/shop/web is not merged, so it was kept.",
      "hint": "To delete it anyway, run `git -C \"/home/me/shop/web\" branch -D feat/login`."
    }
  ],
  "project": "/home/me/shop/.projects/feat--login",
  "branch": "feat/login",
  "repos": [
    { "repo": "api", "status": "ok", "message": "worktree removed, branch deleted", "branchDeleted": true },
    {
      "repo": "web",
      "status": "ok",
      "message": "worktree removed, branch kept: not merged",
      "hint": "git -C \"/home/me/shop/web\" branch -D feat/login",
      "branchDeleted": false
    }
  ]
}
```

## Errors

| Code | When |
| --- | --- |
| `missing-argument` | No `<project>`, and no picker can open, or the codebase has no project. `error.details` is `{ "argument": "project", "choices": [<name>] }`. The exit code is 2. |
| `not-a-codebase` | The folder is not a codebase or a project folder. |
| `project-not-found` | No project of this codebase has that folder name or branch. `error.details.project` is the name. The hint is `xr project list`. It also comes when the project record is gone by the time the lock is taken, for example when another program deleted it while you picked. Nothing changes. |
| `project-drift` | A folder in the project folder is not a repo of the project. `error.details` is `{ "path", "folders" }`. Also with `--force`. Nothing changes. |
| `uncommitted-changes` | A worktree has changed, staged or untracked files. `error.details.worktrees` lists each worktree as `{ "repo", "path", "files" }`. The hint names `--force`. Nothing changes. |
| `sh-not-found` | `pre-remove` is set, and Windows has no Git for Windows `sh.exe`. Nothing changes. |
| `hook-failed` | A `pre-remove` line failed or timed out. The hint names `project.pre-remove`. `error.details` has `command`, `exitCode`, `timedOut` and `hookOutput.lines`. The project stays whole. |
| `git-failed` | A git command failed. In the delete phase, `error.details.leftovers` lists what is left. |
| `git-too-old` | git is older than 2.27. |
| `lock-held` | Another `xr` command holds the lock of this codebase. Nothing changes. |
| `interrupted` | You pressed Ctrl-C, or Ctrl-C or Escape in the picker. In the check phase nothing changes. In the delete phase, `error.details.leftovers` lists what is left. The exit code is 130. |

Warning codes, in `warnings`:

| Code | When |
| --- | --- |
| `branch-not-merged` | `--delete-branch` kept a branch that git says is not merged. The hint has the `git branch -D` command. The exit code stays 0. |
| `invalid-project-record` | A project record is not valid. That project is skipped. |

See [Output and errors](../../output/) for the exit codes.
