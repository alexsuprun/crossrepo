---
title: xr project sync
description: Fetch origin and merge the default branch into each worktree of a project, also with uncommitted changes.
---

`xr project sync` brings new code from the default branch into a project. Use it when you work on a project for some days: in each repo of the project, it fetches `origin` and merges `origin/<default branch>` into the project branch. Your uncommitted changes stay.

```sh
xr project sync
xr project sync <project>
```

It works in a codebase folder or in a project folder, or with `--codebase-path <path>`. In any other folder it fails with `not-a-codebase`. It has no options of its own, only the [global flags](../../output/#global-flags).

## The project

| Argument | What it does |
| --- | --- |
| `<project>` | The project to sync: its folder name, such as `feat--login`, or its branch, such as `feat/login`. The folder name is tried first. An unknown name fails with `project-not-found`. |

With no `<project>`:

- In a project folder, the command syncs that project.
- In a codebase folder, in a terminal, a picker "Pick the project to sync" opens. It lists the project folder names, with the branch of each one next to it. Ctrl-C or Escape in the picker stops the command with `interrupted` (exit code 130), and nothing changes. The picker opens before the lock is taken.
- In a codebase folder with no terminal, or with `--no-interactive` or `--json`, the command fails with `missing-argument` (exit code 2), and `error.details` is `{ "argument": "project", "choices": [...] }` with the project folder names. Nothing runs.

## The default branch

For each repo, the default branch is the `default-branch` of the repo in the config. When the config has none, it is the branch that `origin/HEAD` points to. When neither is set, the repo fails with the `no-default-branch` message, and the hint says to run `git -C "<repo>" remote set-head origin --auto` or to set `default-branch` in the config. This is the same rule as in [xr project create](../project-create/) and [xr project repo add](../project-repo-add/).

## What it does

The command takes the codebase lock, `.crossrepo/xr.lock`, reads the project record again, then goes through the repos of the project, one at a time, in record order. It runs no `xr` hook, such as `post-create`. git's own hooks, such as `pre-merge-commit` and `post-merge`, run as usual in the merge.

First, before any git write, a repo fails with no change when:

| Problem | Message | Hint |
| --- | --- | --- |
| The worktree folder does not exist. | `worktree folder missing` | `xr project doctor` |
| The worktree is on another branch. | ``on branch `<x>`, not `<branch>` `` | ``Run `git -C "<path>" switch <branch>`.`` |
| The worktree has a detached HEAD. | `detached HEAD` | ``Run `git -C "<path>" switch <branch>`.`` |
| A merge waits for `--continue` or `--abort`. | `merge in progress` | ``Run `git -C "<path>" merge --continue` or `git -C "<path>" merge --abort`.`` |
| The worktree has unmerged files and no merge in progress, for example left by an earlier sync whose uncommitted changes conflicted. The repo item has `files`. | ``unmerged files: `a`, `b` `` (at most 5 names, then `and N more`) | ``Fix the files, then run `git -C "<path>" reset`; if `git stash list` has the `autostash` entry of sync, run `git -C "<path>" stash drop`.`` |
| The repo has no default branch. | The `no-default-branch` message. | The set-head hint above. |

Then it runs `git fetch origin` in the worktree. git's progress goes to stderr as it comes. When the fetch fails, only that repo fails, with the git message (the first `fatal:` or `error:` line), and the other repos go on.

Then it runs `git merge --autostash --no-edit refs/remotes/origin/<default branch>` in the worktree. The full ref name means that a local branch or tag named `origin/<default branch>` does not change what is merged. Messages use the short name `origin/<b>`.

- `--autostash` puts your uncommitted changes aside before the merge and back after it, so they stay. What was staged comes back unstaged.
- `--no-edit` takes git's merge message, so no editor opens.

The merge goes into the project branch only. The command never switches branches, never rebases, and never makes a commit of its own. The merge commits of `xr project sync` are the only commits `xr` makes.

There is no undo across repos. A failed or conflicted repo does not stop the others.

## Results

| Status | Message | Meaning |
| --- | --- | --- |
| `ok` | `up to date` | `origin/<default branch>` had nothing new. |
| `ok` | `fast-forwarded to origin/<b>` | The project branch had no own commits, so git moved it forward. |
| `ok` | `merged origin/<b>` | Both sides had commits, so git made a merge commit. |
| `conflict` | ``merge conflict in N files: `a`, `b` `` | The same lines changed on both sides. At most 5 file names show, then `and N more`. |
| `conflict` | ``merged origin/<b>, but your changes conflict with it: they stay in `git stash list` `` | The merge passed, but your uncommitted changes did not go back on top. |
| `failed` | The check or git message. | See the checks above. Any other git error, for example no user identity for the merge commit, is `failed` with the git message. |
| `skipped` | `interrupted` | Ctrl-C stopped the command before the repo was done. |

## Conflicts

`xr` never fixes, stops or commits a conflict. The worktree stays in git's conflict state for you.

For a merge conflict, the repo item has `files`, the list of files with a conflict. Fix the files, then run `git -C "<path>" merge --continue`, or run `git -C "<path>" merge --abort` to go back to before the merge. git puts your uncommitted changes back when the merge ends either way.

When the merge passed but your uncommitted changes conflict with it, the repo item has `stashKept: true`, and `files` lists the unmerged files. git already put your changes back, with conflict markers in those files, and it also keeps a copy in `git stash list`, as an `autostash` entry. So `git stash pop` does not work here. Fix the files, then run `git -C "<path>" reset` to clear the conflict state, and `git -C "<path>" stash drop` to remove the copy.

Then run `xr project sync` again. A worktree with a merge in progress, or with unmerged files, fails the checks until you finish.

## Output

After each repo, stderr gets one line with its status:

```text
✓ api: fast-forwarded to origin/main
! web: merge conflict in 1 file: `src/app.ts`
  Fix the files, then run `git -C "/work/shop/.projects/feat--login/web" merge --continue`, or run `git -C "/work/shop/.projects/feat--login/web" merge --abort`.
✗ docs: worktree folder missing
  xr project doctor
```

| Symbol | Status |
| --- | --- |
| `✓` | `ok` |
| `!` | `conflict` |
| `✗` | `failed` |
| `–` | `skipped` |

On success stdout gets the project path, the branch, and the same repo lines. When stdout and stderr are both the terminal, the repo lines are not printed twice. On a failure stdout stays empty, and stderr gets the error after the lines.

## JSON

With `--json`, stdout is one JSON object with `project` (the absolute project folder), `branch`, and `repos` in record order. Each item is `{ "repo", "status", "message", "hint"?, "files"?, "stashKept"? }`.

```json
{
  "ok": true,
  "warnings": [],
  "project": "/work/shop/.projects/feat--login",
  "branch": "feat/login",
  "repos": [
    { "repo": "api", "status": "ok", "message": "fast-forwarded to origin/main" },
    { "repo": "web", "status": "ok", "message": "up to date" }
  ]
}
```

Any `failed` or `conflict` repo fails the run with `repos-failed` (exit code 1), and `repos` sits next to `error`. An agent finds the conflicted repos by `status`:

```json
{
  "ok": false,
  "warnings": [],
  "project": "/work/shop/.projects/feat--login",
  "branch": "feat/login",
  "repos": [
    { "repo": "api", "status": "ok", "message": "merged origin/main" },
    {
      "repo": "web",
      "status": "conflict",
      "message": "merge conflict in 1 file: `src/app.ts`",
      "hint": "Fix the files, then run `git -C \"/work/shop/.projects/feat--login/web\" merge --continue`, or run `git -C \"/work/shop/.projects/feat--login/web\" merge --abort`.",
      "files": ["src/app.ts"]
    }
  ],
  "error": {
    "code": "repos-failed",
    "message": "1 of 2 repos has conflicts: web.",
    "hint": "Fix each failed or conflicted repo, then run `xr project sync` again."
  }
}
```

The message counts both kinds, for example `1 of 3 repos failed, 1 has conflicts: api, web.`

## Ctrl-C

When you press Ctrl-C during a fetch, git stops at once, and that repo is `skipped` with `interrupted`. A merge that runs is not stopped: the command waits for it and keeps its result. Every repo not reached yet is `skipped` with `interrupted`. The command releases the lock and exits with code 130 and the `interrupted` error, with `repos` next to `error`. It is safe to run `xr project sync` again.

A second Ctrl-C exits at once. Then the lock file stays, and the next command takes it over with the `stale-lock` warning.

## Errors

| Code | When |
| --- | --- |
| `not-a-codebase` | The folder is not a codebase or a project folder. Nothing runs. |
| `missing-argument` | No `<project>` in a codebase folder, and no terminal for the picker. The exit code is 2. |
| `project-not-found` | No project has this folder name or branch, or the project was removed while you picked. |
| `usage` | An unknown option or a second argument. The exit code is 2. |
| `lock-held` | Another `xr` command holds the lock of this codebase. Nothing runs. |
| `git-too-old` | git is older than 2.27. |
| `repos-failed` | At least one repo is `failed` or `conflict`. The other repos still ran. |
| `interrupted` | You pressed Ctrl-C. The exit code is 130. |

See [Output and errors](../../output/) for the exit codes.
