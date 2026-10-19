---
title: xr codebase clone
description: Clone each repo of the codebase that is not on disk yet.
---

`xr codebase clone` gets the repos of a codebase onto disk. Use it after you get the codebase config from a teammate: it clones each repo in the config that has no folder yet.

```sh
xr codebase clone
```

It works only in a codebase folder, or with `--codebase-path <path>`. It has no arguments and no options of its own, only the [global flags](../../output/#global-flags).

## What it does

The command takes the codebase lock, `.crossrepo/xr.lock`, then goes through the repos of the merged config, one at a time, in config order. For each repo:

- When `<codebase>/<name>/.git` exists, as a folder or a file, the repo is `skipped` with the message `already on disk`. git does not run. Any `.git` counts as on disk: the command does not check that its `origin` matches the `remote` in the config.
- When the folder `<codebase>/<name>` exists but has no `.git`, the repo is `failed` with the message `folder has no .git`. The folder is never deleted, and nothing is cloned into it. The hint says to move or delete it.
- When the repo has no `remote` in the config, the repo is `failed` with the message `no remote in the config`. The hint says to add `remote` for the repo in `.crossrepo/config.yaml` or `.crossrepo/config.local.yaml`.
- Otherwise it runs a plain `git clone <remote> <codebase>/<name>`, with no branch and no depth options, so git checks out the default branch of the remote. The repo is `ok`.

The remote comes from the merged config, so a `remote` in `config.local.yaml` wins over the one in `config.yaml`. It goes to git exactly as written.

The repos are cloned one after another, never at the same time. There is no undo across repos: a repo that is cloned stays cloned, also when a later repo fails. A failed repo does not stop the others.

When a clone fails, the command deletes the folder that git made, and the repo is `failed` with the first line that git printed. When that delete fails too, the hint says to delete the partial folder with `rm -r "<path>"`, then run `xr codebase clone` again. A folder that existed before the clone started is never deleted.

The command never writes the config or `AGENTS.md`. It changes only repo folders.

## Output

git's own output, such as `Cloning into '...'` and the progress, goes to stderr. After each repo, stderr gets one line with its status:

```text
✓ api
– web: already on disk
✗ docs: no remote in the config
  Add `remote` for `docs` in .crossrepo/config.yaml or .crossrepo/config.local.yaml.
```

On success stdout gets the same lines, one per repo, so a script that reads stdout gets the full list. When stdout and stderr are both the terminal, stdout gets nothing, so you see each line once. A codebase with no repos prints nothing. On a failure stdout stays empty, and stderr gets the error after the lines, with no second copy of the lines.

| Symbol | Status | Meaning |
| --- | --- | --- |
| `✓` | `ok` | The repo was cloned. |
| `–` | `skipped` | The repo is already on disk, or Ctrl-C stopped the command before the repo was done. |
| `✗` | `failed` | The repo could not be cloned. When there is a hint, it says what to do. |

## JSON

With `--json`, stdout is one JSON object. `repos` lists every repo of the config once, in config order. Each item is `{ "repo", "status", "message"?, "hint"? }`; `message` and `hint` are there only when they are set.

```json
{
  "ok": true,
  "warnings": [],
  "repos": [
    { "repo": "api", "status": "ok" },
    { "repo": "web", "status": "skipped", "message": "already on disk" }
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
      "message": "no remote in the config",
      "hint": "Add `remote` for `docs` in .crossrepo/config.yaml or .crossrepo/config.local.yaml."
    }
  ],
  "error": {
    "code": "repos-failed",
    "message": "1 of 2 repos failed: docs.",
    "hint": "Fix each failed repo, then run `xr codebase clone` again."
  }
}
```

## Ctrl-C

When you press Ctrl-C, git stops and the folder of the repo that was cloning is deleted. That repo and every repo not reached yet are `skipped` with the message `interrupted`. The repos done before keep their status and stay on disk. The command releases the lock and exits with code 130 and the `interrupted` error, with `repos` next to `error`. When the folder of the stopped clone cannot be deleted, `error.details.leftovers` lists it with the `rm -r "<path>"` command.

A second Ctrl-C exits at once. Then the lock file stays, and the next command takes it over with the `stale-lock` warning. The partial folder of the stopped clone can stay too, with no leftover that names it; the next `xr codebase clone` reports that repo as `failed` with `folder has no .git`, so move or delete the folder first.

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
