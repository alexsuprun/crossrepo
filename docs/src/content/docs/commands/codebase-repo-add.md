---
title: xr codebase repo add
description: Clone a repo into a codebase, or add a repo folder that is already in it.
---

`xr codebase repo add` adds one repo to the codebase. It clones a new repo from a URL, or it adds a repo folder that is already directly in the codebase.

```sh
xr codebase repo add <url> [name]
xr codebase repo add <folder>
xr codebase repo add
```

It works only in a codebase folder, or with `--codebase-path <path>`.

## URL or folder

When the argument is a path that exists, it is a folder. A relative path starts at the folder where you run `xr`. Any other argument is a URL. To clone a repo from a local path, give a `file://` URL, for example `file:///home/me/repos/api.git`.

### Clone from a URL

`xr codebase repo add <url>` runs a plain `git clone <url> <codebase>/<name>`. The remote is stored exactly as you give it. git prints its output on stderr.

The name is the last part of the URL, split on `/`, `\` and `:`, without a trailing `/` and `.git`. So `git@github.com:acme/api.git` gives `api`. To use another name, give it after the URL:

```sh
xr codebase repo add git@github.com:acme/api.git svc
```

A name must not be empty, must not have `/`, `\` or `..` in it, and must not start with `.`.

### Add a folder

`xr codebase repo add <folder>` adds a repo that is already directly in the codebase folder. Nothing is cloned. The name is the folder name, so you cannot give a name with a folder. The folder must have a `.git`, an `origin` remote and `origin/HEAD`, the same as for [xr codebase init](../codebase-init/).

```sh
xr codebase repo add ./web
```

A folder outside the codebase, or deeper in it, fails with `not-in-codebase`. Move the folder into the codebase first.

### Pick a folder

`xr codebase repo add` with no argument opens a picker "Pick the folder to add" in a terminal. It lists the folders directly in the codebase that have a `.git` and whose name is not a repo in the config yet (also not in `config.local.yaml`), sorted by name. Pick one with the arrow keys and Enter. Then the command runs the same as `xr codebase repo add <codebase>/<folder>`. Ctrl-C or Escape in the picker stops the command with `interrupted` (exit code 130), and nothing changes. The picker opens before the lock is taken.

The picker opens only when stdin and stdout are a terminal, and neither `--json` nor `--no-interactive` is given. Otherwise the command fails with `missing-argument`, and the message lists the folders, for example `Give a git URL to clone, or a folder in the codebase to add. Folders: lib.` With `--json`, `error.details` is `{ "argument": "folder", "choices": ["lib"] }`.

When no folder can be picked, the command fails with `missing-argument` and the message `There is no folder to add.` in every mode, also in a terminal. `choices` is empty. Give a URL to clone instead.

## What it changes

1. It clones the repo (only for a URL).
2. It reads `origin` and `origin/HEAD` of the repo. The default branch comes from `origin/HEAD`.
3. It adds the repo at the end of `repos:` in the codebase config, `.crossrepo/config.yaml` or `.crossrepo/config.yml`:

   ```yaml
   repos:
     api:
       remote: git@github.com:acme/api.git
       default-branch: main
       description: ""
   ```

   Comments and the order of keys stay. `repos: {}` becomes a block of repos. It never writes `config.local.yaml` or the user config. A symlinked config file is written through the symlink.
4. It writes the `## Codebase` section of `AGENTS.md` with the new repo in the list.

It takes the codebase lock, `.crossrepo/xr.lock`, before any check, and deletes it at the end. When a step fails, or you press Ctrl-C, the steps that were done are undone: the config and `AGENTS.md` get their old text back, and a folder that this run cloned is deleted. A folder that you added is never deleted.

It never runs `git init`, never commits, never changes `.gitignore` and never changes the remote URL.

## Output

stderr gets one line for each step, the git output of the clone, and one line for the repo with its default branch. stdout gets one line for the added repo: its name, its remote, its default branch, its description (empty), then `✓` when the repo was cloned or `–` when it was a folder already.

```text
api  git@github.com:acme/api.git  main    ✓
```

## JSON

With `--json`, stdout is one JSON object. The git output stays on stderr. `added` has one item. `cloned` is `true` for a clone and `false` for a folder.

```json
{
  "ok": true,
  "warnings": [],
  "added": [
    { "repo": "api", "remote": "git@github.com:acme/api.git", "defaultBranch": "main", "description": "", "cloned": true }
  ]
}
```

## Errors

| Code | When |
| --- | --- |
| `usage` | A folder with a name, a name that is not valid, or too many arguments. Nothing changes. The exit code is 2. |
| `missing-argument` | No argument, and no picker can open (no terminal, `--json` or `--no-interactive`), or no folder can be picked. `error.details` is `{ "argument": "folder", "choices": [<folder>] }`. Nothing changes and no lock is taken. The exit code is 2. |
| `not-a-codebase` | The folder is not a codebase. A project folder is not accepted either. |
| `repo-exists` | The codebase config has the name already (also in `config.local.yaml`, or as an empty key), or the folder to clone into exists. Nothing changes. |
| `not-in-codebase` | The folder is not directly in the codebase folder. Nothing changes. The hint says to move it into the codebase first. |
| `repos-not-ready` | The folder has no `.git` (problem `not a repo`), or the repo has no `origin` remote or no `origin/HEAD`, for example a clone of an empty repo. `error.details.repos` has the repo as `{ "repo", "problem", "fix" }`. A folder that this run cloned is deleted. |
| `git-too-old` | git is older than 2.27. |
| `git-failed` | A git command failed, for example a clone of a URL that does not exist. |
| `lock-held` | Another `xr` command holds the lock of this codebase. Nothing changes. |
| `interrupted` | You pressed Ctrl-C, or Ctrl-C or Escape in the picker. The steps that were done are undone. The exit code is 130. |

When a step fails and an undo also fails, `error.details.leftovers` lists each thing left as `{ "what", "path", "command" }`.

See [Output and errors](../../output/) for the exit codes.
