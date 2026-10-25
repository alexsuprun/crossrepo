---
title: xr project info
description: Show the branch, folder, codebase and repos of one project, and which worktree folders exist.
---

`xr project info` prints the details of one project: its branch, its folder, its codebase, when it was made, and its repos.

```sh
xr project info
xr project info <project>
```

It works in a codebase folder and in a project folder. In any other folder, use `--codebase-path <path>`. It changes nothing, takes no lock and runs no git command.

## Arguments

| Argument | What it does |
| --- | --- |
| `<project>` | The project folder name, such as `feat--login`, or the branch, such as `feat/login`. A folder name wins over a branch. |

With no `<project>` in a project folder, it shows that project. With no `<project>` in a codebase folder, it fails with `missing-argument`, and the message lists the projects. It never opens a picker, also in a terminal.

The lookup sees the same projects as [xr project list](../project-list/). A record that is not valid is skipped with the warning `invalid-project-record`.

## Output

stdout gets one line for each field, then the repos in record order. `path` is relative to the codebase when `projects-dir` is inside the codebase, else relative to `~` when it is in your home folder, else absolute. `codebase` is relative to `~` when it is in your home folder, else absolute.

```text
project   feat--login
branch    feat/login
path      .projects/feat--login
codebase  ~/work/acme
created   2026-10-20T14:03:12Z
repos
  ✓ api
  ✓ web
  – docs   worktree folder missing
```

A repo shows `✓` when its worktree folder `<project>/<repo>` exists, and `–` with "worktree folder missing" when it does not. This checks the folder only, with no git command. A project from an old record with no `created` shows an empty `created` line.

## JSON

With `--json`, stdout is one JSON object. The paths are absolute. `created` is `null` when the record has none. `present` is `true` when the worktree folder exists.

```json
{
  "ok": true,
  "warnings": [],
  "project": "feat--login",
  "branch": "feat/login",
  "path": "/home/me/work/acme/.projects/feat--login",
  "codebase": "/home/me/work/acme",
  "created": "2026-10-20T14:03:12Z",
  "repos": [
    { "repo": "api", "path": "/home/me/work/acme/.projects/feat--login/api", "present": true },
    { "repo": "web", "path": "/home/me/work/acme/.projects/feat--login/web", "present": true },
    { "repo": "docs", "path": "/home/me/work/acme/.projects/feat--login/docs", "present": false }
  ]
}
```

## Errors

| Code | When |
| --- | --- |
| `usage` | More than one argument. The exit code is 2. |
| `missing-argument` | No `<project>` in a codebase folder. `error.details` is `{ "argument": "project", "choices": [<project>] }`. With no projects, `choices` is empty and the hint says to run `xr project create`. The exit code is 2. |
| `project-not-found` | No project of this codebase has that folder name or branch. `error.details.project` is the name. The hint is `xr project list`. The exit code is 1. |
| `invalid-project-record` | In a project folder with no `<project>`, the record of that project is not valid (for example, not YAML or no `branch`). The exit code is 1. |
| `not-a-codebase` | The folder is not a codebase or a project, or the project's `codebase` path is not a codebase. `xr` never looks in parent folders. |
| `config-conflict` | One config level has both `.yaml` and `.yml`. |
| `invalid-config` | A config file is not valid YAML, or a value has the wrong type. |

See [Output and errors](../../output/) for the exit codes.
