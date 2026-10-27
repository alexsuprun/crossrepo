---
title: Quick start
description: Go from a folder of sibling repos to a first project, then sync it and remove it.
---

This page goes from a folder of repos to a first project and back. It takes four `xr` commands. Install `xr` first, see [Install](../install/).

The output on this page comes from a real run of `xr` in a test folder. The test repos have local `origin` remotes, so the remotes show as `~/origins/api.git`. Yours show your real URLs, such as `git@github.com:acme/api.git`. Your commit ids differ too.

## 1. Start with a folder of repos

Put the repos you work on side by side in one folder. Clone each one with `git clone`, so each has an `origin` remote and `origin/HEAD`:

```text
~/work/acme/
  api/
  web/
```

If a repo has no `origin/HEAD`, for example because you made it with `git init` and `git remote add`, the next step fails with `repos-not-ready`, writes nothing, and prints the fix for each repo:

```text
$ xr codebase init
✓ api: main
✗ web: no origin/HEAD
error: 1 repo is not ready: web.
Run the fix for each repo, then run `xr codebase init` again.

web  no origin/HEAD  git -C "/Users/you/work/acme/web" remote set-head origin --auto
```

## 2. Make the folder a codebase

```text
$ cd ~/work/acme
$ xr codebase init
✓ api: main
✓ web: main
Create .crossrepo/…
✓ Create .crossrepo/
Write .crossrepo/config.yaml…
✓ Write .crossrepo/config.yaml
Write AGENTS.md…
✓ Write AGENTS.md
~/work/acme

api  ~/origins/api.git  main
web  ~/origins/web.git  main
```

`xr codebase init` writes the codebase config `.crossrepo/config.yaml` with each repo, its remote and its default branch. It also writes a `## Codebase` section in `AGENTS.md`. It never commits. See [xr codebase init](../commands/codebase-init/) and the [config guide](../guides/config/).

## 3. Create a project

A project is one branch in many repos. `--all` takes every repo of the codebase, so no picker opens:

```text
$ xr project create feat/login --all
Fetch api…
✓ Fetch api
Fetch web…
✓ Fetch web
Make project folder…
✓ Make project folder
Add worktree api…
✓ Add worktree api
Add worktree web…
✓ Add worktree web
Write project record…
✓ Write project record
Write AGENTS.md…
✓ Write AGENTS.md
.projects/feat--login

feat/login

✓ api: new branch from origin/main
✓ web: new branch from origin/main
```

The project folder is `.projects/feat--login/`: each `/` of the branch becomes `--`. It has one git worktree of each repo, all on the branch `feat/login`:

```text
~/work/acme/.projects/feat--login/
  .crossrepo/
  AGENTS.md
  api/
  web/
```

To take only some repos, give their names instead of `--all`, such as `xr project create feat/login api`. See [xr project create](../commands/project-create/).

## 4. Work in the project folder

Each repo folder in the project is a normal git worktree. Edit, commit and push there as usual. Your repos in `~/work/acme/` stay on their own branch.

```sh
cd ~/work/acme/.projects/feat--login/api
# edit files
git commit -am "Add login"
cd ~/work/acme
```

`xr` does not look in parent folders. Run `xr` in the codebase folder or in the project folder, not in a worktree folder inside it.

## 5. Sync the project

When the default branch gets new commits, bring them into the project. Give the project name, so no picker opens:

```text
$ xr project sync feat--login
✓ api: up to date
remote: Enumerating objects: 5, done.
remote: Counting objects: 100% (5/5), done.
remote: Total 3 (delta 0), reused 0 (delta 0), pack-reused 0 (from 0)
From ~/origins/web
   dd24034..474093f  main       -> origin/main
✓ web: fast-forwarded to origin/main
.projects/feat--login

feat/login
```

In each worktree, `xr project sync` fetches `origin` and merges the default branch into the project branch. Your uncommitted changes stay. When a merge has a conflict, that repo shows `conflict`; see [xr project sync](../commands/project-sync/) for what to do.

## 6. Remove the project

When the work is done, remove the project:

```text
$ xr project remove feat--login
Remove worktree api…
✓ Remove worktree api
Remove worktree web…
✓ Remove worktree web
Remove project folder…
✓ Remove project folder
.projects/feat--login

feat/login

✓ api: worktree removed, branch kept
✓ web: worktree removed, branch kept
```

The worktrees and the project folder are gone. The branch `feat/login` stays in each repo. To delete merged branches too, add `--delete-branch`. When a worktree has uncommitted changes, the remove stops and changes nothing, unless you add `--force`. See [xr project remove](../commands/project-remove/).

## Next

- [Config guide](../guides/config/): the config levels and keys, and how to keep the codebase config in git.
- [Hooks guide](../guides/hooks/): run your own commands after create and before remove, for example to copy `.env` files.
- [Output and errors](../output/): text and JSON output, and the exit codes.
- [xr doctor](../commands/doctor/): when a step fails, check the codebase or the project and get the fix for each problem.
