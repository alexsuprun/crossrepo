---
title: Config
description: Where the crossrepo config lives, how the three levels merge, the keys, and how to keep the codebase config in git.
---

You edit the crossrepo config by hand, in YAML. `xr codebase init` writes the first codebase config for you. `xr codebase repo add` and `xr codebase repo remove` change the `repos:` list. There is no command to set a value.

## Three levels

`xr` reads up to three files, in this order. A later level wins.

| Level | File | Use it for |
| --- | --- | --- |
| user | `~/.crossrepo/config.yaml` | Your own defaults for every codebase. |
| codebase | `<codebase>/.crossrepo/config.yaml` | The repos and hooks of one codebase. You can share it with your team, see [Keep the codebase config in git](#keep-the-codebase-config-in-git). |
| local | `<codebase>/.crossrepo/config.local.yaml` | Your own changes for one codebase. `xr` never writes this file. |

- Each file can end in `.yaml` or `.yml`. Both at one level is the error `config-conflict`, and the message names both files.
- A missing file is skipped.
- A config file that is a symlink is followed.

## Merge rules

- A later level wins: local over codebase, codebase over user.
- Maps merge key by key. For example, a local file can set only `repos.api.remote`, and `repos.api.default-branch` still comes from the codebase config.
- Lists are replaced whole. A `project.post-create` list in the local file replaces the whole list of the codebase config. An empty list, `[]`, gives no hook lines.
- A key with no value, or with `null`, counts as not set at that level. It does not clear the value of an earlier level.

To see the merged result and the file that gives each value, run [xr config show](../../commands/config-show/).

## Keys

| Key | What it is |
| --- | --- |
| `name` | The codebase name. Hooks get it as `CROSSREPO_CODEBASE_NAME`. When it is not set, the name is the codebase folder name. |
| `projects-dir` | The folder that holds the projects. The default is `.projects`. A relative path is relative to the codebase folder, also in the user config. See [the `projects-dir` rules](../../commands/config-show/#projects-dir). |
| `repos.<name>.remote` | The URL of the repo. `xr codebase clone` clones it, exactly as written. |
| `repos.<name>.default-branch` | The branch that new project branches start from and that `xr project sync` merges. When it is not set, `xr` uses the branch that `origin/HEAD` points to. |
| `repos.<name>.description` | A short text about the repo. `xr` puts it in `AGENTS.md` and shows it in the repo lists. |
| `project.pre-create` | A list of shell commands to run in `xr project create` before it makes anything. See the [hooks guide](../hooks/). |
| `project.post-create` | A list of shell commands to run after `xr project create`. See the [hooks guide](../hooks/). |
| `project.pre-remove` | A list of shell commands to run before `xr project remove` deletes anything. See the [hooks guide](../hooks/). |
| `project.post-remove` | A list of shell commands to run after `xr project remove` has removed the project. See the [hooks guide](../hooks/). |
| `project.vars` | Your own variables for hooks. See the [hooks guide](../hooks/#your-own-variables). |

The `repos:` list decides which repos the codebase has. A repo folder that is not in the list is not a repo of the codebase.

Every key can go in every level. For example, a user config can set `projects-dir` for all your codebases.

A value with the wrong type is the error `invalid-config`, and the message names the file and the key. A key that `xr` does not know gives the warning `unknown-config-key` with a "did you mean" hint, and the command still runs.

A codebase config looks like this:

```yaml
name: acme
repos:
  api:
    remote: git@github.com:acme/api.git
    default-branch: main
    description: Public REST API
  web:
    remote: git@github.com:acme/web.git
    default-branch: main
    description: Frontend
project:
  post-create:
    - npm ci
  vars:
    PORT: 3000
```

## The other remote protocol

`xr` uses each `remote` exactly as written. When the team config has SSH URLs and you use HTTPS, or the other way round, there are two ways to fix it on your machine.

**1. Set the remote in `config.local.yaml`.** Maps merge key by key, so you only set the remote:

```yaml
# <codebase>/.crossrepo/config.local.yaml
repos:
  api:
    remote: https://github.com/acme/api.git
```

**2. Use a git `insteadOf` rule.** git then changes the URL for every repo, also outside crossrepo:

```sh
git config --global url."https://github.com/".insteadOf "git@github.com:"
```

## Keep the codebase config in git

crossrepo does not put its config in git for you. The `.crossrepo/` folder is outside every repo. To share the codebase config with your team, move it into a repo and make a symlink to it. You make the symlink. `xr` only follows it: when `xr` writes the codebase config, it writes the file that the link points to and never replaces the link.

**1. In a repo you have already.** Good when one repo already holds shared setup.

```sh
cd ~/work/acme
mv .crossrepo/config.yaml api/crossrepo.yaml
ln -s ../api/crossrepo.yaml .crossrepo/config.yaml
```

Then commit and push `crossrepo.yaml` in `api`.

**2. In a new `meta` repo.** Good when the config, hook scripts and shared files such as `AGENTS.md` belong together. Make an empty repo `meta` on your git host, then:

```sh
cd ~/work/acme
git clone git@github.com:acme/meta.git
mv .crossrepo/config.yaml meta/crossrepo.yaml
ln -s ../meta/crossrepo.yaml .crossrepo/config.yaml
```

Then commit and push `crossrepo.yaml` in `meta`. `meta` is a normal repo for crossrepo. To have a worktree of it in your projects, add it with `xr codebase repo add ./meta` (see [xr codebase repo add](../../commands/codebase-repo-add/)). Like every repo, it needs an `origin` remote and `origin/HEAD`. A clone of an empty repo has no `origin/HEAD`, so after the first push run `git -C meta remote set-head origin --auto`.

A teammate clones the repo with the config into a new codebase folder, makes the same symlink, and runs [xr codebase clone](../../commands/codebase-clone/) to clone the other repos:

```sh
mkdir -p ~/work/acme/.crossrepo && cd ~/work/acme
git clone git@github.com:acme/meta.git
ln -s ../meta/crossrepo.yaml .crossrepo/config.yaml
xr codebase clone
```

On Windows, make the symlink in `cmd` with `mklink`. It needs Developer Mode turned on, or a shell run as administrator:

```bat
mklink .crossrepo\config.yaml ..\meta\crossrepo.yaml
```
