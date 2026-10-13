---
title: xr codebase init
description: Make a folder of sibling git repos into a crossrepo codebase.
---

`xr codebase init` makes the current folder a codebase. It finds the git repos directly in the folder and writes them to the codebase config.

```sh
cd ~/code/shop
xr codebase init
```

Run it in a folder that is not a codebase or a project yet. In any other folder, use `--codebase-path <path>`.

## What it does

1. It finds the repos: each folder directly in the codebase folder that has a `.git` file or folder, sorted by name. A `.git` in the codebase folder itself is ignored, and subfolders deeper down are not searched. A symlink to a repo folder is skipped.
2. It reads two things from each repo, with no network call:
   - the `origin` remote URL, exactly as it is written in the repo's git config;
   - the default branch, from `origin/HEAD`.
3. It makes the `.crossrepo/` folder.
4. It writes `.crossrepo/config.yaml`.
5. It writes the `## Codebase` section of `AGENTS.md`. The rest of `AGENTS.md` stays as it is. When there is no `AGENTS.md`, it makes one. It never writes `CLAUDE.md`.

Steps 3 to 5 are all-or-nothing. When a step fails, the steps that are done are undone, so the folder is as it was before. When an undo also fails, the error lists what is left and the command to remove it.

It never runs `git init`, never commits and never changes `.gitignore`. If any repo has no `origin` remote or no `origin/HEAD`, nothing is written, and the error lists each such repo with the git command that fixes it.

It needs git 2.27 or newer.

## Lock and Ctrl-C

`xr codebase init` takes the codebase lock, `.crossrepo/xr.lock`, right after step 3 makes `.crossrepo/`, and deletes it at the end. While it runs, another `xr` command that changes files in this folder fails with `lock-held`.

Ctrl-C during steps 3 to 5 undoes the steps that are done: `.crossrepo/` is deleted, a new `AGENTS.md` is deleted, and an old `AGENTS.md` gets its old text back. Then `xr` exits with code 130 and the `interrupted` error. Ctrl-C during steps 1 and 2 stops `xr` at once, before anything is written. See [Lock and Ctrl-C](../../output/#lock-and-ctrl-c).

## The config

Each repo gets its `remote`, its `default-branch` and an empty `description`. The file also has two hook examples that are commented out: one copies untracked files such as `.env` into each new worktree, and one stops a remove when a worktree has commits that are not pushed.

```yaml
# crossrepo codebase config. Docs: https://alexsuprun.github.io/crossrepo/
repos:
  api:
    remote: git@github.com:acme/api.git
    default-branch: main
    description: ""

# project:
#   post-create:
#     ...
```

With no repos, the config has `repos: {}`. Add repos later with `xr codebase repo add <url>|<folder>`.

Edit the file by hand to add a `description` or other keys. See [xr config show](../config-show/) for how the config files work.

## Output

stderr gets one line for each repo with its default branch, then one line for each step. stdout gets the codebase folder and one line for each repo added: its name, its remote and its default branch.

```text
✓ api: main
✓ web: main
Create .crossrepo/…
✓ Create .crossrepo/
Write .crossrepo/config.yaml…
✓ Write .crossrepo/config.yaml
Write AGENTS.md…
✓ Write AGENTS.md
```

```text
~/code/shop

api  git@github.com:acme/api.git  main
web  git@github.com:acme/web.git  main
```

## JSON

With `--json`, stdout is one JSON object. `codebase` is the absolute path of the folder. `added` has one item for each repo.

```json
{
  "ok": true,
  "warnings": [],
  "codebase": "/home/me/code/shop",
  "added": [
    { "repo": "api", "remote": "git@github.com:acme/api.git", "defaultBranch": "main" }
  ]
}
```

With no repos, `added` is empty and `notes` has the hint to add a repo.

## Errors

| Code | When |
| --- | --- |
| `already-a-codebase` | The folder has `.crossrepo/config.yaml` or `config.yml`, or a `.crossrepo/` folder with no config. Nothing changes. The hint says how to add a repo or start again. |
| `inside-a-project` | The folder is a project. Nothing changes. |
| `repos-not-ready` | A repo has no `origin` remote or no `origin/HEAD`. Nothing is written. `error.details.repos` lists each repo as `{ "repo", "problem", "fix" }`, where `fix` is the git command to run. |
| `git-too-old` | git is older than 2.27. The message has the version found. |
| `git-failed` | A git command failed, for example in a broken repo. |
| `lock-held` | Another `xr` command holds the lock of this folder. Nothing is written. |
| `interrupted` | You pressed Ctrl-C during steps 3 to 5. The steps that were done are undone. The exit code is 130. |

When a step fails and an undo also fails, `error.details.leftovers` lists each thing left as `{ "what", "path", "command" }`. The same is true after Ctrl-C.

See [Output and errors](../../output/) for the exit codes.
