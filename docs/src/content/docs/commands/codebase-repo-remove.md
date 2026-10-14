---
title: xr codebase repo remove
description: Remove a repo from a codebase and delete its folder, without losing work.
---

`xr codebase repo remove` takes one repo out of the codebase. It removes the repo from the codebase config and from the `## Codebase` section of `AGENTS.md`, and it deletes the repo folder.

```sh
xr codebase repo remove <name>
xr codebase repo remove <name> --keep-folder
xr codebase repo remove <name> --force
```

It works only in a codebase folder, or with `--codebase-path <path>`.

## Options

| Option | What it does |
| --- | --- |
| `--keep-folder` | Removes the repo from the config and `AGENTS.md`, and keeps the folder. It does not check the folder for work. |
| `--force` | Deletes the folder even when it has work that is only there. Use it only when you are sure. |

With both options, `--keep-folder` wins and the folder stays.

## Checks first

The command takes the codebase lock, `.crossrepo/xr.lock`, then checks everything before it changes anything. When a check fails, nothing changes.

1. The name must be a key of `repos:` in the codebase config, `.crossrepo/config.yaml` or `.crossrepo/config.yml`. A key with no value counts too. A repo that is only in `config.local.yaml` is not found, because `xr` never edits that file.
2. No project of this codebase may use the repo. `xr` reads each `.crossrepo/project.yaml` directly in the projects folder (`projects-dir`). A project belongs to this codebase when its `codebase` path is the same folder, also through another path or a symlink. No option skips this check: remove the repo from the project, or remove the project, first.
3. When the repo folder exists, and you give neither `--keep-folder` nor `--force`, git checks the folder for work that a delete would lose:
   - uncommitted changes, also new files that are not ignored,
   - commits on a local branch that are on no remote, and commits on a detached `HEAD` that no branch or remote has (shown as the branch `HEAD`),
   - stashes.

   The check only reads. It does not change the repo.

A repo folder with no `.git` is never deleted, also not with `--force`, because git cannot check it. Use `--keep-folder` to remove only the entry.

## What it changes

1. It removes the repo entry from `repos:` in the codebase config. Comments and the order of keys stay. When it was the last repo, the config has `repos: {}`. A symlinked config file is written through the symlink. It never writes `config.local.yaml` or the user config.
2. It writes the `## Codebase` section of `AGENTS.md` without the repo.
3. It deletes the repo folder. This step is skipped with `--keep-folder`, or when the folder does not exist.

These steps have no undo. When a step fails, the command stops, and `error.details.leftovers` lists the step that failed and every step that did not run, each with the command to finish it by hand. When you press Ctrl-C during these steps, the running step ends first, then the command stops and lists the leftovers the same way.

The command never runs a git command that changes a repo, and never runs a hook.

## Output

stderr gets one line for each step. stdout gets the name of the removed repo and whether the folder was deleted:

```text
api

folderDeleted: true
```

## JSON

With `--json`, stdout is one JSON object. `folderDeleted` is `false` with `--keep-folder` and when the folder did not exist.

```json
{ "ok": true, "warnings": [], "removed": "api", "folderDeleted": true }
```

## Errors

| Code | When |
| --- | --- |
| `usage` | No name, or more than one name. Nothing changes and no lock is taken. The exit code is 2. |
| `not-a-codebase` | The folder is not a codebase. A project folder is not accepted either. |
| `repo-not-found` | The codebase config has no repo with this name. The hint names `xr codebase repo list`. |
| `repo-in-use` | A project of this codebase uses the repo. `error.details.projects` lists the project folder names. No option skips this check. |
| `invalid-project-record` | A `.crossrepo/project.yaml` in the projects folder is not valid YAML, is not a map, or has no `codebase` path or no `repos` list or map. The message names the file. Fix the file, or remove that project folder. |
| `would-lose-work` | The repo folder has work that a delete would lose. The message lists each kind with the git command that keeps it (`commit`, `push`, `stash list`). `error.details` is `{ "uncommitted": [<file>], "unpushed": [{ "branch", "count" }], "stashes": <number> }`. Also when the folder has no `.git`; then there are no details. Use `--keep-folder` or `--force`. |
| `git-too-old` | git is older than 2.27. |
| `git-failed` | A git command of the check failed. |
| `lock-held` | Another `xr` command holds the lock of this codebase. Nothing changes. |
| `interrupted` | You pressed Ctrl-C. During the checks nothing changes. During the steps, `error.details.leftovers` lists what is left. The exit code is 130. |

See [Output and errors](../../output/) for the exit codes.
