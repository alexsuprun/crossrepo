---
title: xr codebase repo list
description: List the repos of a codebase and show which of them are on disk.
---

`xr codebase repo list` prints each repo of the codebase config, and whether the repo is on disk.

```sh
xr codebase repo list
```

It works in a codebase folder and in a project folder. In a project folder it lists the repos of the project's codebase. In any other folder, use `--codebase-path <path>`. It changes nothing, takes no lock and runs no git command.

## What it shows

The repos come from the merged config, in the order of the config files. A value in `config.local.yaml` wins, so a local `remote` is the one that shows. See [xr config show](../config-show/) for how the config files work.

A repo is present when `<codebase>/<name>/.git` exists, as a file or a folder.

## Output

stdout gets one line for each repo: its name, its remote, its default branch, its description, then `✓` when the repo is present or `–` when it is not. A value that is not set in the config is empty. The text output is for people: empty values and values with spaces make it unsafe to split, so scripts must use `--json`.

```text
api  git@github.com:acme/api.git  main  The API  ✓
web  git@github.com:acme/web.git  main           –

Clone the missing repos with `xr codebase clone`.
```

Hints follow the table:

- When a repo folder does not exist, one hint for all such repos says to run `xr codebase clone`.
- When a repo folder exists but has no `.git`, one hint for each such folder names it and says to move or delete it, because `xr codebase clone` cannot use it.

With no repos, it prints `The codebase has no repos.` and the hint to run `xr codebase repo add <url>|<folder>`.

## JSON

With `--json`, stdout is one JSON object. `entries` has one item for each repo. `present` is `true` or `false`. A value that is not set in the config is `""`.

```json
{
  "ok": true,
  "warnings": [],
  "entries": [
    { "repo": "api", "remote": "git@github.com:acme/api.git", "defaultBranch": "main", "description": "The API", "present": true },
    { "repo": "web", "remote": "git@github.com:acme/web.git", "defaultBranch": "main", "description": "", "present": false }
  ],
  "notes": ["Clone the missing repos with `xr codebase clone`."]
}
```

When a hint shows, `notes` has its text. With no repos, `entries` is empty and `notes` has the hint to add a repo.

## Errors

| Code | When |
| --- | --- |
| `not-a-codebase` | The folder is not a codebase or a project, or the project's `codebase` path is not a codebase. `xr` never looks in parent folders. |
| `config-conflict` | One config level has both `.yaml` and `.yml`. |
| `invalid-config` | A config file is not valid YAML, or a value has the wrong type. |

See [Output and errors](../../output/) for the exit codes.
