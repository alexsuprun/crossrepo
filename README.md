# crossrepo

[![npm version](https://img.shields.io/npm/v/crossrepo)](https://www.npmjs.com/package/crossrepo)
[![CI](https://github.com/alexsuprun/crossrepo/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/alexsuprun/crossrepo/actions/workflows/ci.yml?query=branch%3Amaster)
[![License: MIT](https://img.shields.io/npm/l/crossrepo)](https://github.com/alexsuprun/crossrepo/blob/master/LICENSE)

Create, sync and remove the same git worktree branch across many sibling repos with one command.

## Why

When one change touches many repos, you make the same branch in each repo, keep each branch up to date, and clean up each one at the end. crossrepo does this for all the repos at once.

- **One command for many repos.** `xr project create feat/login --all` makes the branch `feat/login` in every repo of the codebase.
- **One folder for each change.** Each project is a folder with one git worktree per repo. You can work on two changes at the same time, and your main repos never switch branches.
- **Safe to clean up.** `xr project remove` stops when a worktree has uncommitted changes, unless you add `--force`. It keeps your branches, and with `--delete-branch` it deletes only merged branches.
- **Made for scripts and agents.** Every command gives the same result as JSON with `--json`. `xr` writes an `AGENTS.md` that tells AI agents about the codebase and its repos.

## Install

```sh
npm i -g crossrepo
```

```sh
bun add -g crossrepo
```

Both ways need Node 22.13 or newer, also with `bun add -g`, because the installed `xr` runs with Node.

To run crossrepo with no Node and no global install, use `bunx`. It needs only Bun 1.3 or newer:

```sh
bunx crossrepo --version
```

When an older Node is on your `PATH`, `bunx` runs `xr` with it. Then use `bunx --bun crossrepo`, so Bun runs it.

The package installs two commands that do the same thing: `xr` and `crossrepo`. See [Install](https://alexsuprun.github.io/crossrepo/install/) for more.

## Quick start

Put the repos you work on side by side in one folder, each cloned with `git clone`. Then:

```sh
cd ~/work/acme                       # your folder of repos
xr codebase init                     # make it a codebase
xr project create feat/login --all   # branch feat/login in every repo
cd .projects/feat--login/api         # edit, commit and push as usual
cd ~/work/acme
xr project sync feat--login          # merge the default branch into each worktree
xr project remove feat--login        # remove the worktrees and the project folder
```

The [Quick start](https://alexsuprun.github.io/crossrepo/quick-start/) page shows each step with its output.

## Agents

Install the agent skills for any agent with `npx skills add alexsuprun/crossrepo`. In Claude Code, install them as a plugin with `/plugin marketplace add alexsuprun/crossrepo`, then `/plugin install xr@xr`. To match the skills to your `xr` version, pin its release tag: `npx skills add alexsuprun/crossrepo#v<version>`. This works from the first release that has the skills.

- `xr`: runs `xr` with `--json --no-interactive`, reads the result, and handles error codes and sync conflicts.
- `xr-init`: sets up a codebase and writes a description of each repo for `AGENTS.md`.
- `xr-hooks`: writes project hooks in the right config file.

Claude Code reads `AGENTS.md` from version 2.1.281. See [Agent skills](https://alexsuprun.github.io/crossrepo/skills/).

## Platforms

| Need | Version |
| --- | --- |
| OS | macOS, Linux, WSL, native Windows |
| Node | 22.13 or newer, for `npm i -g` and `bun add -g` |
| Bun | 1.3 or newer, only for `bunx crossrepo` |
| git | 2.27 or newer |

On native Windows, hooks run with the `sh.exe` of [Git for Windows](https://gitforwindows.org).

## Hooks run as you

Hooks are shell commands in your config that `xr` runs before and after `xr project create` and `xr project remove`: `pre-create`, `post-create`, `pre-remove` and `post-remove`. They run as your user, with your rights, and with no trust step: `xr` does not ask before it runs a hook from a codebase config. Read the hooks of a codebase with `xr config show` before you use it. See [SECURITY.md](https://github.com/alexsuprun/crossrepo/blob/master/SECURITY.md) and the [hooks guide](https://alexsuprun.github.io/crossrepo/guides/hooks/).

## Remote protocol

The codebase config in git holds one remote URL for each repo, for example SSH. To use the other protocol, for example HTTPS, do one of these:

Set the remote in `config.local.yaml`, the config level for your own changes. `xr` never writes this file. Add one entry for each repo:

```yaml
# <codebase>/.crossrepo/config.local.yaml
repos:
  api:
    remote: https://github.com/acme/api.git
```

Or add a git `insteadOf` rule. git then changes the URL for every repo, also outside crossrepo:

```sh
git config --global url."https://github.com/".insteadOf "git@github.com:"
```

See the [config guide](https://alexsuprun.github.io/crossrepo/guides/config/).

## Links

- Docs: <https://alexsuprun.github.io/crossrepo/>
- Commands: <https://alexsuprun.github.io/crossrepo/#commands>
- Output and errors: <https://alexsuprun.github.io/crossrepo/output/>
- Changelog: [CHANGELOG.md](https://github.com/alexsuprun/crossrepo/blob/master/CHANGELOG.md)
- Issues: <https://github.com/alexsuprun/crossrepo/issues>
- Contributing: [CONTRIBUTING.md](https://github.com/alexsuprun/crossrepo/blob/master/CONTRIBUTING.md)
- License: [MIT](https://github.com/alexsuprun/crossrepo/blob/master/LICENSE)
