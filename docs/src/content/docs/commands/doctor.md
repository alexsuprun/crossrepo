---
title: xr doctor
description: Check the codebase or the project of the current folder, and print each problem with its fix.
---

`xr doctor` is one command for both doctors. It looks at the folder you are in and runs the right checks: the checks of [`xr project doctor`](../project-doctor/) in a project folder, or the checks of [`xr codebase doctor`](../codebase-doctor/) in a codebase folder. It prints each problem with the fix. It changes nothing.

```sh
xr doctor
```

It has no arguments and no options of its own, only the [global flags](../../output/#global-flags). An argument is a usage error (exit code 2). It never opens a picker and never asks for a project name.

## Which checks run

The folder is found as for every command: the current folder, or the folder of `--codebase-path` when you give it.

| Folder | What runs | `scope` |
| --- | --- | --- |
| A project folder, also one whose record is broken or whose codebase moved | [`xr project doctor`](../project-doctor/) for this project: the seven codebase checks, then the seven project checks, with the same `skipped` rules. | `project` |
| A codebase folder | [`xr codebase doctor`](../codebase-doctor/): the seven codebase checks. | `codebase` |
| Any other folder | Nothing. The command fails with `not-a-codebase`. | — |

The checks, their order, the exit code and the items are the same as in the command that runs. See [project doctor checks](../project-doctor/#checks) and [codebase doctor checks](../codebase-doctor/#checks). To check another project from a codebase folder, use `xr project doctor <project>`.

The command only reads. It takes no lock, writes no file, and runs only git commands that read. A config that cannot load still fails before any check runs, with `invalid-config` or `config-conflict`.

## Exit code

The exit code is 0 when no item is `error`, also when there are `warn` or `skipped` items. When at least one item is `error`, the command fails with `checks-failed` and exit code 1.

## Output

The first line is the scope, `project` or `codebase`, then an empty line, then the output of the command that runs. In a project folder:

```text
project

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
✓ worktree-branch
✓ project-drift
✓ project-agents-md
```

In a codebase folder:

```text
codebase

✓ unknown-config-key
✓ reserved-var-name
✓ repo-not-in-config
✓ repo-folder-missing
✓ agents-heading-no-repo
✓ agents-repo-no-heading
✓ stale-worktree
```

On a failure stdout stays empty, and stderr gets the same lines, then the error.

## JSON

With `--json`, stdout is one JSON object: the JSON of the command that runs, with `scope` added after `warnings`. In a project folder:

```json
{
  "ok": true,
  "warnings": [],
  "scope": "project",
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

In a codebase folder:

```json
{
  "ok": true,
  "warnings": [],
  "scope": "codebase",
  "checks": [
    { "id": "unknown-config-key", "status": "ok" },
    { "id": "reserved-var-name", "status": "ok" },
    { "id": "repo-not-in-config", "status": "ok" },
    { "id": "repo-folder-missing", "status": "ok" },
    { "id": "agents-heading-no-repo", "status": "ok" },
    { "id": "agents-repo-no-heading", "status": "ok" },
    { "id": "stale-worktree", "status": "ok" }
  ]
}
```

On a failure `"ok"` is `false`, and `scope`, `project` (in a project folder) and `checks` sit next to `error`.

## Errors

| Code | When |
| --- | --- |
| `checks-failed` | At least one item is `error`. `scope`, `project` (in a project folder) and `checks` list every item. |
| `not-a-codebase` | The folder is not a codebase or a project folder. The hint says to run it in a codebase folder or a project folder, or to give `--codebase-path`. Nothing runs. |
| `invalid-config` | The config is not valid. Nothing runs. |
| `config-conflict` | One level has both `config.yaml` and `config.yml`. Nothing runs. |
| `usage` | An argument, or an unknown option. The exit code is 2. |
| `git-too-old` | git is older than 2.27. |

See [Output and errors](../../output/) for the exit codes.
