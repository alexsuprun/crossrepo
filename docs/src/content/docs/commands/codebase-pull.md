---
title: xr codebase pull
description: Fast-forward the checked-out branch of each repo of the codebase.
---

`xr codebase pull` brings the repos of a codebase up to date. Use it before you start new work, so new projects start from new code: it runs `git pull` in each repo that is on disk.

```sh
xr codebase pull
```

It works only in a codebase folder, or with `--codebase-path <path>`. It has no arguments and no options of its own, only the [global flags](../../output/#global-flags).

## What it does

The command takes the codebase lock, `.crossrepo/xr.lock`, then goes through the repos of the merged config, one at a time, in config order. For each repo:

- When the folder `<codebase>/<name>` does not exist, the repo is `skipped` with the message `missing`. git does not run. The hint says to clone the missing repos with `xr codebase clone`.
- When the folder `<codebase>/<name>` exists but has no `.git`, the repo is `failed` with the message `folder has no .git`. git does not run, and the folder is not touched. The hint says to move or delete it, then run `xr codebase clone` again.
- Otherwise it runs `git pull --ff-only --no-rebase` in the repo. The repo is `ok` when git ends with no error, also when there was nothing new.

git pulls the branch that is checked out, from the upstream that this branch has in git. The command never switches branches, and it does not use the `remote` of the config.

`--ff-only` and `--no-rebase` make sure that the pull never changes your own commits:

- git only moves the branch forward to the upstream (a fast-forward). It never makes a merge commit.
- git never rebases, also when your git config has `pull.rebase=true`.
- When your branch and its upstream both have new commits, git stops and changes nothing.

The command does not check for a detached HEAD or a missing upstream first: git finds these and fails, and the command reads git's error text to give the hint.

The repos are pulled one after another, never at the same time. There is no undo across repos: a repo that is pulled stays pulled, also when a later repo fails. A failed repo does not stop the others.

The command never writes the config or `AGENTS.md`, and it never makes or deletes a folder.

## Failed repos

A failed repo has the git message: the first `fatal:` or `error:` line that git printed, or else its first line that is not a `hint:` line. The hint names the next step:

| Problem | Hint |
| --- | --- |
| Your branch and its upstream both have new commits. | Merge or rebase by hand in `<dir>`, then run `xr codebase pull` again. |
| The branch has no upstream. | Set an upstream for the branch in `<dir>` (git branch --set-upstream-to), then run `xr codebase pull` again. |
| HEAD is not on a branch (detached HEAD). | Check out a branch in `<dir>`, then run `xr codebase pull` again. |
| Changed or untracked files would be overwritten. git changes no files. | Commit or stash the changes in `<dir>`, then run `xr codebase pull` again. |
| Any other git error, for example the remote cannot be reached. | No repo hint. |

## Output

git's own output, such as `From <url>`, `Fast-forward` and `Already up to date.`, goes to stderr. After each repo, stderr gets one line with its status:

```text
✓ api
– web: missing
  Clone the missing repos with `xr codebase clone`.
✗ docs: fatal: Not possible to fast-forward, aborting.
  Merge or rebase by hand in /work/shop/docs, then run `xr codebase pull` again.
```

On success stdout gets the same lines, one per repo. A codebase with no repos prints nothing. On a failure stdout stays empty, and the lines and the error go to stderr.

| Symbol | Status | Meaning |
| --- | --- | --- |
| `✓` | `ok` | The repo was pulled, or it was up to date already. |
| `–` | `skipped` | The repo is not on disk, or Ctrl-C stopped the command before the repo was done. |
| `✗` | `failed` | The repo could not be pulled. When there is a hint, it says what to do. |

## JSON

With `--json`, stdout is one JSON object. `repos` lists every repo of the config once, in config order. Each item is `{ "repo", "status", "message"?, "hint"? }`; `message` and `hint` are there only when they are set. An `ok` repo has no message.

```json
{
  "ok": true,
  "warnings": [],
  "repos": [
    { "repo": "api", "status": "ok" },
    {
      "repo": "web",
      "status": "skipped",
      "message": "missing",
      "hint": "Clone the missing repos with `xr codebase clone`."
    }
  ]
}
```

On a failure, `repos` sits next to `error`:

```json
{
  "ok": false,
  "warnings": [],
  "repos": [
    { "repo": "api", "status": "ok" },
    {
      "repo": "docs",
      "status": "failed",
      "message": "fatal: Not possible to fast-forward, aborting.",
      "hint": "Merge or rebase by hand in /work/shop/docs, then run `xr codebase pull` again."
    }
  ],
  "error": {
    "code": "repos-failed",
    "message": "1 of 2 repos failed: docs.",
    "hint": "Fix each failed repo, then run `xr codebase pull` again."
  }
}
```

## Ctrl-C

When you press Ctrl-C, git stops. The repo that was pulling and every repo not reached yet are `skipped` with the message `interrupted`. The repo that was pulling is `interrupted` also when git had already pulled it, or had updated only part of it. The repos done before keep their status. It is safe to run `xr codebase pull` again. The command releases the lock and exits with code 130 and the `interrupted` error, with `repos` next to `error`.

A second Ctrl-C exits at once. Then the lock file stays, and the next command takes it over with the `stale-lock` warning.

## Errors

| Code | When |
| --- | --- |
| `not-a-codebase` | The folder is not a codebase. A project folder is not accepted either. Nothing runs. |
| `usage` | An argument or an unknown option. The exit code is 2. |
| `lock-held` | Another `xr` command holds the lock of this codebase. Nothing runs. |
| `git-too-old` | git is older than 2.27. |
| `repos-failed` | At least one repo is `failed`. The other repos still ran. `repos` lists each repo with its message and hint. |
| `interrupted` | You pressed Ctrl-C. The exit code is 130. |

See [Output and errors](../../output/) for the exit codes.
