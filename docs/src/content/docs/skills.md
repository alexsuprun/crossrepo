---
title: Agent skills
description: Install the crossrepo agent skills with npx skills or as a Claude Code plugin, so an agent uses xr the right way.
---

crossrepo has three agent skills. They teach an AI agent to run `xr`, to describe the repos of a codebase, and to write project hooks. The skills are in the [crossrepo repo](https://github.com/alexsuprun/crossrepo/tree/master/skills), not in the npm package.

## Install with npx skills

[`npx skills`](https://github.com/vercel-labs/skills) installs the skills for many agents, such as Claude Code, Codex and Cursor:

```sh
npx skills add alexsuprun/crossrepo
```

To match the skills to your `xr` version, pin its release tag, with your `xr` version in place of `<version>`. This works from the first release that has the skills:

```sh
npx skills add alexsuprun/crossrepo#v<version>
```

To see the skills first, add `--list`. To install one skill, add `--skill` with its name:

```sh
npx skills add alexsuprun/crossrepo --list
npx skills add alexsuprun/crossrepo --skill xr-init
```

## Install as a Claude Code plugin

In Claude Code, add the repo as a plugin marketplace, then install the plugin `xr`:

```text
/plugin marketplace add alexsuprun/crossrepo
/plugin install xr@xr
```

The skills then show with the prefix `xr:`, such as `xr:xr-init`. Skills need Claude Code 2.0.20 or newer. Claude Code reads the `AGENTS.md` that `xr` writes from version 2.1.281.

## The skills

| Skill | What it does |
| --- | --- |
| `xr` | Runs `xr` with `--json` and `--no-interactive`, reads the result, acts on the error codes, and helps fix the conflicts of `xr project sync`. It never adds `--force` or `--delete-branch` without your yes. |
| `xr-init` | Writes a description of each repo, in the config and in the codebase `AGENTS.md`, from the README, manifest and `AGENTS.md` of each repo. It has two modes. **Set up**: in a folder that is not a codebase yet, it runs `xr codebase init` first. **Refresh**: in a codebase, it reads each repo again and proposes only the changes, one at a time. It saves nothing before you agree. |
| `xr-hooks` | Writes [hooks](../guides/hooks/) in the config level you choose, as POSIX `sh`, and checks them with `xr codebase doctor`. It runs a test create and remove only with your yes. |

For the JSON result and the error codes that the skills read, see [Output and errors](../output/).
