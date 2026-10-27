---
title: crossrepo
description: Create, sync and remove the same git worktree branch across many sibling repos with one command.
---

crossrepo creates, syncs and removes the same git worktree branch across many sibling repos with one command. The command is `xr`.

When one change touches many repos, you make the same branch in each repo, keep each branch up to date, and clean up each one at the end. crossrepo does this for all the repos at once. Each change gets its own folder with one git worktree per repo, so you can work on two changes at the same time and never switch branches in your main repos.

To start, see [Install](install/) and the [Quick start](quick-start/).

## Four words

| Word | What it is |
| --- | --- |
| codebase | A folder that holds your repos side by side, plus a `.crossrepo/` folder with the codebase config. `xr codebase init` makes a folder a codebase. |
| repo | A git repo directly in the codebase folder and listed under `repos:` in the codebase config. Each repo needs an `origin` remote. |
| project | One piece of work on one branch. It is a folder, by default in `<codebase>/.projects/`, with one worktree of each chosen repo. `xr project create` makes it, and `xr project remove` deletes it. |
| worktree | A git worktree: a second folder of a repo, with its own branch checked out. The repo folder in the codebase stays on its own branch. |

A branch `feat/login` gives the project folder `.projects/feat--login/`: each `/` becomes `--`.

## Commands

Every command works the same way with `--json`, for scripts and agents. See [Output and errors](output/).

### Codebase

- [xr codebase init](commands/codebase-init/): make a folder of sibling git repos into a codebase.
- [xr codebase clone](commands/codebase-clone/): clone each repo of the codebase that is not on disk yet.
- [xr codebase pull](commands/codebase-pull/): fast-forward the checked-out branch of each repo.
- [xr codebase repo add](commands/codebase-repo-add/): clone a repo into the codebase, or add a repo folder that is already in it.
- [xr codebase repo list](commands/codebase-repo-list/): list the repos and show which of them are on disk.
- [xr codebase repo remove](commands/codebase-repo-remove/): remove a repo from the codebase and delete its folder, without losing work.

### Project

- [xr project create](commands/project-create/): make a project with a worktree of each chosen repo on one branch.
- [xr project info](commands/project-info/): show the branch, folder, codebase and repos of one project.
- [xr project list](commands/project-list/): list the projects of the codebase.
- [xr project remove](commands/project-remove/): remove the worktrees and the folder of a project, and keep the branches.
- [xr project sync](commands/project-sync/): fetch `origin` and merge the default branch into each worktree of a project.
- [xr project repo add](commands/project-repo-add/): add a worktree of one or more repos to a project.
- [xr project repo list](commands/project-repo-list/): list the repos of one project.
- [xr project repo remove](commands/project-repo-remove/): remove the worktree of one or more repos from a project.

### Config

- [xr config show](commands/config-show/): print the merged config and the file that gives each value. See also the [config guide](guides/config/) and the [hooks guide](guides/hooks/).

### Doctor

- [xr doctor](commands/doctor/): check the codebase or the project of the current folder.
- [xr codebase doctor](commands/codebase-doctor/): check the codebase config, the repo folders and `AGENTS.md`.
- [xr project doctor](commands/project-doctor/): check one project and its codebase.

Each doctor prints each problem with its fix and changes nothing.

The source code is on [GitHub](https://github.com/alexsuprun/crossrepo).
