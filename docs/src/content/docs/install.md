---
title: Install
description: Install crossrepo with npm or Bun, or run it with bunx, and check what it needs.
---

crossrepo is one npm package, `crossrepo`. It installs two commands that do the same thing: `xr` and `crossrepo`. These docs use `xr`.

## Install with npm or Bun

```sh
npm i -g crossrepo
```

```sh
bun add -g crossrepo
```

Both ways need Node 22.13 or newer, also with `bun add -g`, because the installed `xr` runs with Node.

Check that it works:

```sh
xr --version
```

## Run with bunx

To run crossrepo with no Node and no global install, use `bunx`. It needs only Bun 1.3 or newer.

```sh
bunx crossrepo --version
bunx crossrepo codebase init
```

`bunx` follows the `#!/usr/bin/env node` line of `xr`, so when a Node is on your `PATH`, `bunx crossrepo` runs `xr` with that Node. If that Node is older than 22.13, use `bunx --bun crossrepo` so Bun runs it.

## What crossrepo needs

| Need | Version |
| --- | --- |
| Node | 22.13 or newer, for `npm i -g` and `bun add -g` |
| Bun | 1.3 or newer, only for `bunx crossrepo` |
| git | 2.27 or newer |

With an older git, `xr` stops with the error `git-too-old`.

## Platforms

crossrepo works on macOS, Linux, WSL and native Windows.

On native Windows, `xr` runs [hooks](../guides/hooks/) with the `sh.exe` of [Git for Windows](https://gitforwindows.org). `xr` finds it from the folder of `git.exe` on your `PATH`. When a hook must run and there is no `sh.exe`, the command fails with `sh-not-found` before it changes anything. Commands with no hooks to run do not need `sh.exe`.

## Next

Make your first project with the [Quick start](../quick-start/).
