---
title: xr project doctor
description: Check one project and its codebase, and print each problem with its fix.
---

`xr project doctor` finds problems in a project that a manual git command, a moved folder or a hand edit left behind: a worktree folder that is gone, on another branch or not known to git, a folder that is not a repo of the project, a project record that points to a codebase that moved, or an `AGENTS.md` that does not match the repos. It prints each problem with the fix. It changes nothing.

```sh
xr project doctor [<project>]
```

It works in a codebase folder and in a project folder, also in a project folder whose record is broken. It has no options of its own, only the [global flags](../../output/#global-flags). [`xr doctor`](../doctor/) picks this doctor or the other one from the folder you are in.

## The project

| Argument | What it does |
| --- | --- |
| `<project>` | The project to check: its folder name, such as `feat--login`, or its branch, such as `feat/login`. The folder name is tried first. An unknown name fails with `project-not-found`. A project whose record cannot be read is not found by name from a codebase folder; it shows as a warning, as in [`xr project sync`](../project-sync/). |

With no `<project>`:

- In a project folder, the command checks that project. It does not need a valid record for this: the first project check reads the record.
- In a codebase folder, in a terminal, a picker "Pick the project to check" opens. It lists the project folder names, with the branch of each one next to it. Ctrl-C or Escape in the picker stops the command with `interrupted` (exit code 130).
- In a codebase folder with no terminal, or with `--no-interactive` or `--json`, the command fails with `missing-argument` (exit code 2), and `error.details` is `{ "argument": "project", "choices": [...] }` with the project folder names. Nothing runs.

In a project folder whose record gives no codebase, a `<project>` argument fails with the same `not-a-codebase` error as other commands, since there is no codebase to search.

## What it does

The command first runs the seven checks of [`xr codebase doctor`](../codebase-doctor/#checks) on the codebase of the project, then the seven project checks below, always in this order. A check with no problem gives one `ok` item. A check with problems gives one item per problem, each with a message and a fix. A check that needs data an earlier check could not get is `skipped` (see [Skipped checks](#skipped-checks)).

The command only reads. It takes no lock, writes no file, and every git call only reads: `git worktree list --porcelain` in the codebase repos, and a read of the current branch of each worktree. It never runs `git worktree repair` or `git worktree prune` for you.

A config that cannot load, for example a file with invalid YAML, still fails before any check runs, with `invalid-config` or `config-conflict`.

## Checks

| Id | Status | Problem | Message | Fix |
| --- | --- | --- | --- | --- |
| `project-record` | `error` | `.crossrepo/project.yaml` of the project cannot be read, or it is not a valid record (for example invalid YAML, or no `branch`). | `<record path>: <problem>` | ``correct `.crossrepo/project.yaml`: keys branch, codebase, repos, created`` |
| `codebase-path` | `error` | The `codebase` of the record, resolved from the project folder, does not exist or has no `.crossrepo/config.yaml` (or `config.yml`). | The resolved path. | ``set `codebase` in `.crossrepo/project.yaml` to the codebase folder, then run:`` and one `git -C "<codebase>/<repo>" worktree repair "<worktree path>"` line per repo of the record. On git older than 2.29, the first line is `needs git 2.29 or newer (you have <version>):`. |
| `worktree-missing` | `error` | A repo of the record with no folder in the project folder. | The repo name. | `xr project repo remove <repo> --project <project>`, then `xr project repo add <repo> --project <project>`, with the project folder name. |
| `worktree-not-registered` | `error` | A worktree folder that is not a worktree of its repo in the codebase (for example after you moved the project folder), or whose git cannot be read (for example after the codebase moved). | The worktree path. | `git -C "<codebase>/<repo>" worktree repair "<worktree path>"`. On git older than 2.29, the first line is `needs git 2.29 or newer (you have <version>):`. |
| `worktree-branch` | `warn` | A worktree on another branch than the record `branch`, or with a detached HEAD. | The worktree path, the branch it is on (or `detached HEAD`), and that `xr project sync` refuses this worktree. | `git -C "<worktree path>" switch <branch>` |
| `project-drift` | `error` | A folder in the project folder that is not a repo of the record. | The folder name. | ``move `<folder>` out of the project folder`` |
| `project-agents-md` | `warn` | The project `AGENTS.md` is missing, or does not match the repos. | See below. | See below. |

Some details:

- `codebase-path`: in the fix, `<codebase>` stays as it is, since the right folder is not known. Put the new codebase folder there. The worktree path is the absolute path of each worktree.
- `worktree-not-registered`: a worktree is matched to the entries of `git worktree list` by the file system identity of the folder, not by the path text. A repo whose codebase folder is missing or that git cannot read gives no item here; the codebase checks report it. A worktree that git cannot read gives only this item, not also a `worktree-branch` item.
- `project-drift`: the rule is the same as in [`xr project remove`](../project-remove/): names that start with `.` (such as `.idea` or `.crossrepo`) do not count, and files do not count.
- `project-agents-md` gives these items:
  - `AGENTS.md` is missing: one item with no message and the fix ``add `AGENTS.md` with a `## Codebase` and a `## Repos` section``. No other item of this check.
  - No `## Codebase` section: message `## Codebase`, fix ``add a `## Codebase` section to `AGENTS.md` ``.
  - A `###` heading under `## Repos` that matches no repo of the record: one item per heading, message the heading, fix `remove "### <title>" from "## Repos" in AGENTS.md`.
  - A repo of the record that has a `###` part under `## Repos` of the codebase `AGENTS.md`, but none in the project `AGENTS.md`: one item per repo, message the repo, fix `add "### <repo>" under "## Repos" in AGENTS.md (copy it from the codebase AGENTS.md)`. A missing project `## Repos` counts as no headings.
  - Headings match with spaces trimmed and case ignored. Only the first `## Repos` section counts, and a heading in a code block does not count.

## Skipped checks

A `skipped` item has the message why, and no fix.

- When `project-record` fails, the project checks 2 to 7 are `skipped` with `project record cannot be read`. The codebase checks still run when the codebase was found, for example when the record has a valid `codebase` but no `branch`. Otherwise they are `skipped` with the same message.
- When `codebase-path` fails, the seven codebase checks and `worktree-not-registered`, `worktree-branch` and `project-agents-md` are `skipped` with `codebase not found`. `worktree-missing` and `project-drift` still run.

## Exit code

The exit code is 0 when no item is `error`, also when there are `warn` or `skipped` items. When at least one item is `error`, the command fails with `checks-failed` and exit code 1. The message is the count of `error` items, for example `1 check failed` or `2 checks failed`.

## Output

On success stdout gets the project folder, an empty line, then one line per item: the symbol, the id and, when there is one, two spaces and the message. The fix is a muted line under it. Each further line of a fix that has more than one line gets 2 more spaces.

```text
.projects/feat--login

✓ unknown-config-key
✓ reserved-var-name
✓ repo-not-in-config
✓ repo-folder-missing
✓ agents-heading-no-repo
✓ agents-repo-no-heading
✓ stale-worktree
✓ project-record
✓ codebase-path
✓ worktree-missing
✓ worktree-not-registered
! worktree-branch  /work/shop/.projects/feat--login/api: on branch `main`, not `feat/login`; `xr project sync` refuses this worktree
    fix: git -C "/work/shop/.projects/feat--login/api" switch feat/login
✓ project-drift
✓ project-agents-md
```

| Symbol | Status | Meaning |
| --- | --- | --- |
| `✓` | `ok` | The check found no problem. |
| `!` | `warn` | A problem that does not fail the command. |
| `✗` | `error` | A problem that fails the command with `checks-failed`. |
| `–` | `skipped` | The check did not run, since an earlier check failed. Muted. |

On a failure stdout stays empty, and stderr gets the same lines, then the error.

## JSON

With `--json`, stdout is one JSON object. `project` is the absolute project folder. `checks` lists every item in order. Each item is `{ "id", "status", "message"?, "fix"? }`; `message` and `fix` are there only when they are set. A fix with more than one line has `\n` between the lines. `warnings` does not have the unknown config keys, since they are in `checks`.

```json
{
  "ok": true,
  "warnings": [],
  "project": "/work/shop/.projects/feat--login",
  "checks": [
    { "id": "unknown-config-key", "status": "ok" },
    { "id": "reserved-var-name", "status": "ok" },
    { "id": "repo-not-in-config", "status": "ok" },
    { "id": "repo-folder-missing", "status": "ok" },
    { "id": "agents-heading-no-repo", "status": "ok" },
    { "id": "agents-repo-no-heading", "status": "ok" },
    { "id": "stale-worktree", "status": "ok" },
    { "id": "project-record", "status": "ok" },
    { "id": "codebase-path", "status": "ok" },
    { "id": "worktree-missing", "status": "ok" },
    { "id": "worktree-not-registered", "status": "ok" },
    { "id": "worktree-branch", "status": "ok" },
    { "id": "project-drift", "status": "ok" },
    { "id": "project-agents-md", "status": "ok" }
  ]
}
```

On a failure, `project` and `checks` sit next to `error`. Here the codebase moved:

```json
{
  "ok": false,
  "warnings": [],
  "project": "/work/shop/.projects/feat--login",
  "checks": [
    { "id": "unknown-config-key", "status": "skipped", "message": "codebase not found" },
    { "id": "reserved-var-name", "status": "skipped", "message": "codebase not found" },
    { "id": "repo-not-in-config", "status": "skipped", "message": "codebase not found" },
    { "id": "repo-folder-missing", "status": "skipped", "message": "codebase not found" },
    { "id": "agents-heading-no-repo", "status": "skipped", "message": "codebase not found" },
    { "id": "agents-repo-no-heading", "status": "skipped", "message": "codebase not found" },
    { "id": "stale-worktree", "status": "skipped", "message": "codebase not found" },
    { "id": "project-record", "status": "ok" },
    {
      "id": "codebase-path",
      "status": "error",
      "message": "/work/old-shop",
      "fix": "set `codebase` in `.crossrepo/project.yaml` to the codebase folder, then run:\ngit -C \"<codebase>/api\" worktree repair \"/work/shop/.projects/feat--login/api\""
    },
    { "id": "worktree-missing", "status": "ok" },
    { "id": "worktree-not-registered", "status": "skipped", "message": "codebase not found" },
    { "id": "worktree-branch", "status": "skipped", "message": "codebase not found" },
    { "id": "project-drift", "status": "ok" },
    { "id": "project-agents-md", "status": "skipped", "message": "codebase not found" }
  ],
  "error": {
    "code": "checks-failed",
    "message": "1 check failed"
  }
}
```

This output is from git 2.29 or newer. `git worktree repair` needs git 2.29, so on git 2.27 and 2.28 the `fix` starts with the line `needs git 2.29 or newer (you have 2.28.0):`, then the same lines.

## Errors

| Code | When |
| --- | --- |
| `checks-failed` | At least one item is `error`. `project` and `checks` list every item. |
| `project-not-found` | No project has the given folder name or branch. Nothing runs. |
| `missing-argument` | No `<project>` in a codebase folder, and no picker can open. The exit code is 2. |
| `interrupted` | Ctrl-C or Escape in the picker. The exit code is 130. |
| `not-a-codebase` | The folder is not a codebase or a project folder, or a `<project>` is given in a project folder whose record gives no codebase. Nothing runs. |
| `invalid-config` | The config is not valid. Nothing runs. |
| `config-conflict` | One level has both `config.yaml` and `config.yml`. Nothing runs. |
| `usage` | More than one argument, or an unknown option. The exit code is 2. |
| `git-too-old` | git is older than 2.27. |

See [Output and errors](../../output/) for the exit codes.
