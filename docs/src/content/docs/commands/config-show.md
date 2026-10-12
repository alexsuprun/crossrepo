---
title: xr config show
description: Print the merged config and the file that gives each value.
---

`xr config show` prints every config value that `xr` uses, and the file that gives it. Use it to see which value wins across the user, codebase and local config files.

```sh
xr config show
```

It works in a codebase folder and in a project folder. In a project folder it shows the config of the project's codebase. In any other folder, use `--codebase-path <path>`. It changes nothing and takes no lock.

## Config files

`xr` reads 3 levels, in this order. A later level wins.

| Level | File |
| --- | --- |
| user | `~/.crossrepo/config.yaml` |
| codebase | `<codebase>/.crossrepo/config.yaml` |
| local | `<codebase>/.crossrepo/config.local.yaml` |

- Each file can end in `.yaml` or `.yml`. Both at one level is an error.
- A missing file is skipped.
- Maps merge key by key. Lists, such as `project.post-create`, are replaced whole.
- A config file that is a symlink is followed.
- A key with no value counts as not set.

## Output

Each line is `key = value`, then the source file. Keys are in dotted form, for example `project.vars.PORT`. A source path is relative to the codebase folder or to `~`. A hook list prints the key and the source, and then one command per line.

```text
name                = shop                  .crossrepo/config.yaml
projects-dir        = ~/work                resolved ~/work  ~/.crossrepo/config.yaml
repos.api.remote    = git@github.com:x/api  .crossrepo/config.yaml
project.post-create =                       .crossrepo/config.yaml
  npm ci
  cp ../.env .env
```

## `projects-dir`

`projects-dir` is the folder that holds the projects. `xr config show` prints the value as written and the `resolved` absolute path.

- A relative path is relative to the codebase folder, at every level.
- A leading `~` is your home folder.
- An absolute path stays as it is.
- Nothing else is expanded, such as `$HOME`.
- When no level sets it, it is `.projects`, with the source `default`.

## Unknown keys

A key that `xr` does not know gives the warning `unknown-config-key` on stderr, with a "did you mean" hint. The command still runs. This happens in every `xr` command that reads the config, once per key.

## JSON

With `--json`, stdout is one JSON object. `entries` has one item per key. Paths are absolute. `projects-dir` also has `resolved`. A hook list is one item with an array `value`.

```json
{
  "ok": true,
  "warnings": [],
  "entries": [
    { "key": "name", "value": "shop", "source": "/home/me/code/shop/.crossrepo/config.yaml" },
    { "key": "projects-dir", "value": ".projects", "source": "default", "resolved": "/home/me/code/shop/.projects" },
    { "key": "project.post-create", "value": ["npm ci"], "source": "/home/me/code/shop/.crossrepo/config.yaml" }
  ]
}
```

## Errors

| Code | When |
| --- | --- |
| `not-a-codebase` | The folder has no `.crossrepo/config.yaml`, `config.yml` or `project.yaml`, or the project's `codebase` path is not a codebase. `xr` never looks in parent folders. |
| `config-conflict` | One level has both `.yaml` and `.yml`. The message names both files. |
| `invalid-config` | A file is not valid YAML, or a value has the wrong type. The message names the file and the key. |

See [Output and errors](../../output/) for the exit codes.
