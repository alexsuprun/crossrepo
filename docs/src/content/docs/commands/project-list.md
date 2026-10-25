---
title: xr project list
description: List the projects of a codebase with their branch, created date and repos.
---

`xr project list` prints each project of the codebase, with its branch, the date it was made, and its repos.

```sh
xr project list
```

It works in a codebase folder and in a project folder. In a project folder it lists the projects of the project's codebase. In any other folder, use `--codebase-path <path>`. It changes nothing, takes no lock and runs no git command.

## What it shows

A project is a folder directly in `projects-dir` with a `.crossrepo/project.yaml` whose `codebase` is this codebase. A project of another codebase in the same `projects-dir` is not listed. The projects are in name order. The repos of each project are in the order of its record.

When a record is not valid (for example, not YAML or no `branch`), `xr` skips that project, prints the warning `invalid-project-record` with the path of the record, and lists the other projects. The command still exits with code 0.

## Output

stdout gets one line for each project: its folder name, its branch and the date it was made (UTC). One indented line for each repo follows it. A project from an old record with no `created` has no date.

```text
feat--login  feat/login  2026-10-20
  api
  web
fix--bug     fix/bug     2026-10-18
  api
```

With no projects, it prints the note "No projects. Start one with `xr project create <branch> <repo>...`" and exits with code 0.

## JSON

With `--json`, stdout is one JSON object. `entries` has one item for each project. `path` is the absolute path of the project folder, and `created` is the full time from the record, or `null` when the record has none.

```json
{
  "ok": true,
  "warnings": [],
  "entries": [
    { "project": "feat--login", "branch": "feat/login", "path": "/home/me/shop/.projects/feat--login", "repos": ["api", "web"], "created": "2026-10-20T14:03:12Z" },
    { "project": "fix--bug", "branch": "fix/bug", "path": "/home/me/shop/.projects/fix--bug", "repos": ["api"], "created": "2026-10-18T09:30:00Z" }
  ]
}
```

With no projects, `entries` is empty and `notes` has the note. A skipped record is a warning in `warnings`, as `{ "code": "invalid-project-record", "message", "hint" }`.

## Errors

| Code | When |
| --- | --- |
| `not-a-codebase` | The folder is not a codebase or a project, or the project's `codebase` path is not a codebase. `xr` never looks in parent folders. |
| `config-conflict` | One config level has both `.yaml` and `.yml`. |
| `invalid-config` | A config file is not valid YAML, or a value has the wrong type. |

See [Output and errors](../../output/) for the exit codes.
