---
title: xr project repo list
description: Print each repo of one project, whether its worktree folder exists, and its description.
---

`xr project repo list` prints the repos of one project, in record order. It changes nothing, takes no lock and runs no git command.

```sh
xr project repo list
xr project repo list --project <project>
```

The project is found the same way as in [xr project repo add](../project-repo-add/#which-project): `--project <project>` (folder name or branch) first, else the current project folder, else a picker of the projects in a codebase folder. Not in a terminal, the picker is the error `missing-argument` with `error.details` `{ "argument": "project", "choices": [<name>] }`.

## Output

One line per repo: `✓` when the worktree folder exists and `–` when it is missing, the repo name, then its description from the merged config, or `worktree folder missing`. There is no header.

```text
✓ api    Public REST API
✓ web    Frontend
– docs   worktree folder missing
```

## JSON

With `--json`, `project` is the project folder name, and `entries` has one object per repo. `path` is absolute. `description` is `null` when the config has none. The key is `entries`, not `repos`, because `repos` is the key of per-repo results.

```json
{
  "ok": true,
  "warnings": [],
  "project": "feat--login",
  "entries": [
    { "repo": "api", "path": "/home/me/shop/.projects/feat--login/api", "present": true, "description": "Public REST API" },
    { "repo": "web", "path": "/home/me/shop/.projects/feat--login/web", "present": true, "description": "Frontend" },
    { "repo": "docs", "path": "/home/me/shop/.projects/feat--login/docs", "present": false, "description": "Docs site" }
  ]
}
```

## Errors

| Code | When |
| --- | --- |
| `missing-argument` | In a codebase folder with no `--project`, and no picker can open. The exit code is 2. |
| `not-a-codebase` | The folder is not a codebase or a project folder. |
| `project-not-found` | No project has the name of `--project`. |
| `invalid-project-record` | The record of the current project is not valid. For another project it is a warning, and that project is skipped. |

See [Output and errors](../../output/) for the exit codes.
