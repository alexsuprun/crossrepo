---
title: xr project repo add
description: Add a worktree of one or more repos to a live project, on the project branch, all or nothing.
---

`xr project repo add` adds repos to a project that exists already. For each repo it adds a git worktree on the project branch, then it writes the new repo list to the project record and updates the project `AGENTS.md`. When anything fails, it undoes every step, so the project stays as it was.

```sh
xr project repo add <repo>...
xr project repo add <repo>... --project <project>
xr project repo add
```

## Which project

- `--project <project>` names the project: its folder name, such as `feat--login`, or its branch, such as `feat/login`. The folder name is tried first. It works in a codebase folder and in a project folder, and it wins over the current project. An unknown name fails with `project-not-found`.
- With no `--project`, in a project folder, the command uses that project.
- With no `--project`, in a codebase folder, a picker of the project folder names, with the branch of each one next to it, opens in a terminal. Not in a terminal, or with `--json` or `--no-interactive`, the command fails with `missing-argument`, and `error.details` is `{ "argument": "project", "choices": [<name>] }`.
- In any other folder it fails with `not-a-codebase`. `xr` does not look at parent folders, so in a worktree folder use `--codebase-path <project folder>`.

A project record that is not valid is an error `invalid-project-record` for the current project folder, and for the chosen project when its record is read again inside the lock. The record of another project that is not valid is a warning `invalid-project-record`, and that project is skipped.

## Arguments and options

| Argument or option | What it does |
| --- | --- |
| `<repo>...` | The repos to add, by their names in the codebase config. A name given twice counts once. The repos are added in codebase config order. |
| `--project <project>` | The project to change. See [Which project](#which-project). |

## Pick the repos

With no `<repo>`, a multi-select picker "Pick the repos to add" opens in a terminal. It lists the repos of the merged config that are on disk and not in the project, in config order. Mark at least one with Space, then press Enter. Ctrl-C or Escape stops the command with `interrupted` (exit code 130), and nothing changes.

Not in a terminal, or with `--json` or `--no-interactive`, the command fails with `missing-argument`, and `error.details` is `{ "argument": "repos", "choices": [<repo>] }`. When every repo on disk is in the project already, the command fails with `missing-argument` and the message `Every repo on disk is in the project already.`, with the hint `xr codebase clone`, in every mode.

Both pickers open before the lock is taken.

## Checks first

The command takes the codebase lock, `.crossrepo/xr.lock`, then checks each repo. None of the checks changes anything.

1. The repo is in the merged config, else `repo-not-found` with the hint `xr codebase repo list`.
2. The repo is on disk, else `repos-not-ready` with the hint `xr codebase clone`.
3. The repo is not in the project yet, else `repo-already-in-project`.
4. Nothing is at `<project folder>/<repo>`, no folder and no file, else `project-drift`. Move it out of the project folder, then run the command again. `xr` never deletes it for you.
5. `git fetch origin` passes, the default branch is found, and the project branch is not checked out in another place (`branch-in-use`). These are the same checks as in [xr project create](../project-create/).

## Steps

1. **Add worktree `<repo>`**, one step per repo, with the branch rules of [xr project create](../project-create/): the local branch when it exists, else a new branch that tracks `origin/<branch>`, else a new branch from `origin/<default branch>`.
2. **Write project record**: the record gets the new repos, in codebase config order. The `created` time stays.
3. **Write AGENTS.md**: only the `## Codebase` and `## Repos` sections of the project `AGENTS.md` change. Your own text in the rest of the file stays.

No hook runs, also not `post-create`. When a step fails, or you press Ctrl-C, every step that ran is undone in reverse order: the new worktrees are removed, a branch that the command made is deleted, and the record and `AGENTS.md` get their old text back. A branch that existed before is never deleted. When an undo fails, `error.details.leftovers` lists what is left, each with the command to clean it up by hand.

## Output

stderr gets one line for each check and step. stdout gets the project path, the branch, and one line per added repo:

```text
.projects/feat--login

feat/login

✓ web: new branch from origin/main
```

## JSON

```json
{
  "ok": true,
  "warnings": [],
  "project": "/home/me/shop/.projects/feat--login",
  "branch": "feat/login",
  "repos": [
    { "repo": "web", "status": "ok", "message": "new branch from origin/main", "source": "new" }
  ]
}
```

`source` is `local`, `tracking` or `new`, as in `xr project create`.

## Errors

| Code | When |
| --- | --- |
| `missing-argument` | No project or no repo, and no picker can open, or there is nothing to pick. The exit code is 2. |
| `not-a-codebase` | The folder is not a codebase or a project folder. |
| `project-not-found` | No project has the name of `--project`, or the project record is gone by the time the lock is taken. Nothing changes. |
| `invalid-project-record` | The record of the current project folder is not valid, or the record of the chosen project is not valid when it is read again inside the lock. Nothing changes. For another project it is a warning, and that project is skipped. |
| `repo-not-found` | A repo is not in the merged config. |
| `repos-not-ready` | A repo is not on disk. The hint is `xr codebase clone`. |
| `repo-already-in-project` | A repo is in the project already. |
| `project-drift` | A folder or file is at the worktree path of a repo. `error.details` is `{ "path", "folders" }`. |
| `branch-in-use` | The project branch is checked out in the codebase repo or in another worktree. |
| `no-default-branch` | A repo has no default branch. |
| `git-failed` | A git command failed. Every step is undone. |
| `lock-held` | Another `xr` command holds the lock of this codebase. Nothing changes. |
| `interrupted` | You pressed Ctrl-C, or Ctrl-C or Escape in a picker. Every step is undone. The exit code is 130. |

See [Output and errors](../../output/) for the exit codes.
