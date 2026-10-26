---
title: xr codebase doctor
description: Check the codebase config, the repo folders and AGENTS.md, and print each problem with its fix.
---

`xr codebase doctor` finds problems in a codebase that you edited by hand: a repo that is missing, a key with a typo, a reserved var name, or an `AGENTS.md` that does not match the repos. It prints each problem with the fix. It changes nothing.

```sh
xr codebase doctor
```

It works in a codebase folder and in a project folder. In a project folder it checks the codebase of the project record. It has no arguments and no options of its own, only the [global flags](../../output/#global-flags).

## What it does

The command runs seven checks, always in the order below. A check with no problem gives one `ok` item. A check with problems gives one item per problem, each with a message and a fix.

The command only reads. It takes no lock, writes no file, and runs only git commands that read. It never runs `git worktree prune` for you.

A config that cannot load, for example a file with invalid YAML, still fails before any check runs, with `invalid-config` or `config-conflict`.

## Checks

| Id | Status | Problem | Message | Fix |
| --- | --- | --- | --- | --- |
| `unknown-config-key` | `warn` | A key in a config file (user, codebase or local level) that `xr` does not know. | The dotted key and its files, for example `repo in /work/shop/.crossrepo/config.yaml`. | ``rename it to `<key>` `` with the closest known key, or `remove it`. |
| `reserved-var-name` | `error` | A `project.vars` name that starts with `CROSSREPO_`, in any case. | The name. | ``rename `<name>` in `<file>` ``, with the config file that sets the value in use. |
| `repo-not-in-config` | `warn` | A folder directly in the codebase that has a `.git` and is not a key of `repos:`. | The folder name. | The lines to add to `.crossrepo/config.yaml` (or `config.yml`), with a `remote:` line when the folder has an `origin`. |
| `repo-folder-missing` | `error` | A key of `repos:` with no folder. | The repo name. | `git clone <remote> <name>`, or ``clone the repo into `<name>` `` when the repo has no `remote`. |
| `agents-heading-no-repo` | `warn` | A `###` heading under `## Repos` of the codebase `AGENTS.md` that matches no repo. | The heading text. | `rename it to a repo name, or remove it` |
| `agents-repo-no-heading` | `warn` | A repo of `repos:` with no `###` heading under `## Repos`. | The repo name. | `add "### <repo>" under "## Repos" in AGENTS.md` |
| `stale-worktree` | `warn` | An entry of `git worktree list` in a repo whose folder does not exist, for example a project folder you deleted by hand. | The path of the entry. | `git -C "<repo folder>" worktree prune` |

Some details:

- `unknown-config-key`: an unknown key is only a warning, never an error. Other commands print the same problem as a live warning; this command shows it only as a check, so you do not see it twice.
- `reserved-var-name`: the names that start with `CROSSREPO_` belong to the hook variables of `xr`. [`xr project create`](../project-create/) and [`xr project remove`](../project-remove/) fail with `reserved-var-name` when the config has such a name.
- `repo-not-in-config` and `repo-folder-missing`: a key of `repos:` with nothing under it, such as `web:`, counts as a repo. A configured repo folder that exists but has no `.git` is not reported here; `xr codebase clone` and `xr codebase repo list` tell you about it.
- `agents-heading-no-repo` and `agents-repo-no-heading`: headings match repo names with case ignored. Only the first `## Repos` section counts, and a heading in a code block does not count. When `AGENTS.md` or its `## Repos` section is missing, `agents-repo-no-heading` gives one item with no message and the fix ``add a `## Repos` section with one `### <repo>` per repo``, and `agents-heading-no-repo` is `ok`. With no repos in the config, `agents-repo-no-heading` is `ok`.
- `stale-worktree`: only repos of `repos:` whose folder has a `.git` are checked.

## Exit code

The exit code is 0 when no item is `error`, also when there are warnings. When at least one item is `error`, the command fails with `checks-failed` and exit code 1. The message is the count of `error` items, for example `1 check failed` or `2 checks failed`.

## Output

On success stdout gets one line per item: the symbol, the id and, when there is one, two spaces and the message. The fix is a muted line under it. Each further line of a fix that has more than one line gets 2 more spaces.

```text
! unknown-config-key  repo in /work/shop/.crossrepo/config.yaml
    fix: rename it to `repos`
✓ reserved-var-name
! repo-not-in-config  tools
    fix: add to .crossrepo/config.yaml:
        repos:
          tools:
            remote: git@github.com:acme/tools.git
✓ repo-folder-missing
✓ agents-heading-no-repo
! agents-repo-no-heading  docs
    fix: add "### docs" under "## Repos" in AGENTS.md
✓ stale-worktree
```

| Symbol | Status | Meaning |
| --- | --- | --- |
| `✓` | `ok` | The check found no problem. |
| `!` | `warn` | A problem that does not fail the command. |
| `✗` | `error` | A problem that fails the command with `checks-failed`. |

On a failure stdout stays empty, and stderr gets the same lines, then the error.

## JSON

With `--json`, stdout is one JSON object. `checks` lists every item in order. Each item is `{ "id", "status", "message"?, "fix"? }`; `message` and `fix` are there only when they are set. A fix with more than one line has `\n` between the lines. `warnings` does not have the unknown keys, since they are in `checks`.

```json
{
  "ok": true,
  "warnings": [],
  "checks": [
    { "id": "unknown-config-key", "status": "ok" },
    { "id": "reserved-var-name", "status": "ok" },
    { "id": "repo-not-in-config", "status": "ok" },
    { "id": "repo-folder-missing", "status": "ok" },
    { "id": "agents-heading-no-repo", "status": "ok" },
    {
      "id": "agents-repo-no-heading",
      "status": "warn",
      "message": "docs",
      "fix": "add \"### docs\" under \"## Repos\" in AGENTS.md"
    },
    { "id": "stale-worktree", "status": "ok" }
  ]
}
```

On a failure, `checks` sits next to `error`:

```json
{
  "ok": false,
  "warnings": [],
  "checks": [
    { "id": "unknown-config-key", "status": "ok" },
    { "id": "reserved-var-name", "status": "ok" },
    { "id": "repo-not-in-config", "status": "ok" },
    {
      "id": "repo-folder-missing",
      "status": "error",
      "message": "web",
      "fix": "git clone git@github.com:acme/web.git web"
    },
    { "id": "agents-heading-no-repo", "status": "ok" },
    { "id": "agents-repo-no-heading", "status": "ok" },
    { "id": "stale-worktree", "status": "ok" }
  ],
  "error": {
    "code": "checks-failed",
    "message": "1 check failed"
  }
}
```

## Errors

| Code | When |
| --- | --- |
| `checks-failed` | At least one item is `error`. `checks` lists every item. |
| `not-a-codebase` | The folder is not a codebase or a project folder. Nothing runs. |
| `invalid-config` | The config is not valid. Nothing runs. |
| `config-conflict` | One level has both `config.yaml` and `config.yml`. Nothing runs. |
| `usage` | An argument or an unknown option. The exit code is 2. |
| `git-too-old` | git is older than 2.27. |

See [Output and errors](../../output/) for the exit codes.
