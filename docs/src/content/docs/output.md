---
title: Output and errors
description: How xr prints results and errors, as text or as one JSON object, and which exit codes it uses.
---

Every `xr` command gives one result in one fixed shape. In a terminal you get readable text. With `--json` you get one JSON object that a script or an agent can read.

## Global flags

Every command accepts these 4 flags:

| Flag | Effect |
| --- | --- |
| `--codebase-path <path>` | Use the codebase at `<path>`. |
| `--json` | Print the result as one JSON object on stdout. `xr` never asks questions. |
| `--no-interactive` | Never ask questions. A command with a missing argument fails with `missing-argument` instead of opening a picker. |
| `--verbose` | When `xr` crashes, print the stack trace on stderr. It changes nothing else. |

`xr` asks questions only when stdin and stdout are both a terminal, and neither `--json` nor `--no-interactive` is given. Then a missing argument, for example the repo name of `xr codebase repo remove`, opens a picker on stderr. Pick with the arrow keys and Enter. Ctrl-C or Escape stops the command with `interrupted` (exit code 130) and changes nothing. In every other case, `xr` never reads stdin: a missing argument fails with `missing-argument` and the message lists the choices. One exception: `xr project info` with no project in a codebase folder never opens a picker, also in a terminal. It always fails with `missing-argument`.

## stdout and stderr

Progress goes to stderr: step lines, per-repo results and warnings. Only the final result goes to stdout. So you can pipe stdout to another program and still see the progress in the terminal. When stdout and stderr are both the terminal, the final result leaves out the per-repo lines that stderr already showed, so no line shows twice.

## Output modes

`xr` picks a mode for stdout and for stderr, one at a time. It uses the first rule that matches:

1. `--json` gives `json` (stdout only).
2. `FORCE_COLOR` is set: `rich` when it is empty, `1`, `2`, `3` or `true`, and `plain` for any other value, such as `0` or `false`.
3. `NO_COLOR` is set and is not empty: `plain`.
4. `TERM=dumb`: `plain`.
5. The stream is a terminal: `rich`.
6. Otherwise: `plain`.

`rich` text has colors. `plain` text has no escape codes. Each stream gets its own mode, so a piped stdout is `plain` while stderr in the terminal is `rich`. `FORCE_COLOR` wins over `NO_COLOR`, the same as in Node.

Both text modes use the same symbols:

| Symbol | Meaning |
| --- | --- |
| `✓` | done |
| `✗` | failed |
| `!` | warning |
| `–` | skipped |

## The JSON object

With `--json`, stdout is exactly one JSON object.

On success:

```json
{ "ok": true, "warnings": [], "version": "0.1.0" }
```

On failure:

```json
{
  "ok": false,
  "warnings": [],
  "error": {
    "code": "usage",
    "message": "unknown option '--nope'",
    "hint": "Run `xr --help` for usage."
  }
}
```

- `ok` is `true` on success and `false` on failure.
- `warnings` is always there. Each warning is `{ "code", "message", "hint"?, "lines"? }`. `lines` is there only when the warning has output lines, such as the end of a hook's output. Each warning also goes to stderr when it happens.
- `error` is there only on failure. It has `code` and `message`, and `hint` and `details` only when the error has them.
- `notes` is there only when the command has notes for you, such as a hint for the next step. It is a list of strings.
- The other fields belong to the command. On failure they can be there too, next to `error`.

Read `error.code` to know what failed. Do not read the message or the exit code for this.

`xr` with no command prints the help. `--version` wins over other flags and arguments, and prints the version even next to a bad flag.

`--version` and `--help` follow `--json` too: `xr --json --version` prints `{"ok":true,"warnings":[],"version":"<version>"}`, and `xr --json --help` prints `{"ok":true,"warnings":[],"help":"<text>"}`.

Without `--json`, an error goes to stderr and stdout stays empty.

## Error codes

| Code | Meaning |
| --- | --- |
| `usage` | A bad flag, an unknown command or a missing option value. |
| `missing-argument` | A command needs an argument that you did not give, and `xr` cannot ask for it (no terminal, `--json` or `--no-interactive`), or there is nothing to pick. `xr project info` with no project in a codebase folder always gives this error, also in a terminal. The message lists the choices. `error.details` is `{ "argument", "choices" }`, where `choices` is a list of strings, empty when there is nothing to pick. The exit code is 2. |
| `internal` | A bug in `xr`. Run the command again with `--verbose` and report the output on [GitHub](https://github.com/alexsuprun/crossrepo/issues). |
| `not-a-codebase` | The folder is not a codebase or a project, or the project's `codebase` path is not a codebase. Use `--codebase-path <path>`. |
| `config-conflict` | One config level has both a `.yaml` and a `.yml` file. |
| `invalid-config` | A config file is not valid YAML, or a value has the wrong type. |
| `file-busy` | `xr` could not write a file because another program is using it (Windows only). Close that program and run the command again. |
| `git-too-old` | git is older than 2.27. Upgrade git. |
| `git-failed` | A git command failed. The message names the command and the first line git printed. |
| `repos-not-ready` | A repo has no `origin` remote or no `origin/HEAD`, a folder given to `xr codebase repo add` is not a repo, or a repo chosen for `xr project create` or `xr project repo add` is not on disk. `error.details.repos` lists each repo with the fix. |
| `already-a-codebase` | `xr codebase init` ran in a folder that is a codebase already, or that has a `.crossrepo/` folder. |
| `inside-a-project` | `xr codebase init` ran in a project folder. |
| `repo-exists` | `xr codebase repo add` got a name that the codebase config has already, or the folder to clone into exists. |
| `not-in-codebase` | `xr codebase repo add` got a folder that is not directly in the codebase folder. Move the folder into the codebase first. |
| `repo-not-found` | `xr codebase repo remove` got a name that is not in `repos:` of the codebase config, `xr project create` or `xr project repo add` got a repo name that is not in the config, or `xr project repo remove` got a repo that is not in the project. |
| `repo-in-use` | `xr codebase repo remove` got a repo that a project of this codebase uses. `error.details.projects` lists the projects. |
| `invalid-project-record` | A `.crossrepo/project.yaml` in the projects folder is not valid. The message names the file. In `xr project list` and `xr project info` it is a warning, and the other projects still show. In `xr project remove` it is a warning, and that project is skipped. In `xr project repo add`, `repo remove` and `repo list` it is a warning for the projects that the lookup skips, but an error for the record of the current project folder, and for the record of the chosen project when it is read again inside the lock. |
| `would-lose-work` | `xr codebase repo remove` would delete a repo folder that has uncommitted changes, unpushed commits or stashes, or that has no `.git`. Nothing changes. |
| `repos-failed` | A command that works on each repo, such as `xr codebase clone` or `xr codebase pull`, had at least one repo that failed. The other repos still ran. `repos` lists each repo as `{ "repo", "status", "message"?, "hint"? }`. |
| `project-exists` | `xr project create` found a folder at the project path already. `error.details.path` is the path. |
| `branch-in-use` | `xr project create` or `xr project repo add` got a branch that is checked out in the codebase repo or in another worktree. `error.details` is `{ "repo", "path" }`. |
| `no-default-branch` | `xr project create` or `xr project repo add` found no default branch for a repo: no `default-branch` in the config and no `origin/HEAD`. |
| `hook-failed` | A `pre-create`, `post-create` or `pre-remove` line failed or timed out. `error.details` has `command`, `exitCode`, `timedOut` and `hookOutput.lines`, the last 20 lines of its output. A failed `post-remove` line is a warning instead, see below. |
| `sh-not-found` | A hook must run, and Windows has no Git for Windows `sh.exe`. |
| `project-not-found` | No project of this codebase has the given folder name or branch. `error.details.project` is the name. Run `xr project list` to see the projects. |
| `uncommitted-changes` | `xr project remove` or `xr project repo remove` found changed, staged or untracked files that git does not ignore in a worktree of the project. `error.details.worktrees` lists each worktree as `{ "repo", "path", "files" }`. Nothing changes. Use `--force` to remove anyway. |
| `project-drift` | `xr project remove` found a folder in the project folder that is not a repo of the project. A folder whose name starts with `.`, such as `.idea`, does not count. `error.details` is `{ "path", "folders" }`. Nothing changes, also with `--force`. Move the folder out of the project folder. `xr project repo add` gives it when a folder or file is at the worktree path of a repo to add; move it out of the project folder. |
| `repo-already-in-project` | `xr project repo add` got a repo that is in the project already. Nothing changes. |
| `last-repo` | `xr project repo remove` would remove every repo of the project. Use `xr project remove` to remove the whole project. Nothing changes. |
| `checks-failed` | A doctor command, such as [`xr codebase doctor`](../commands/codebase-doctor/) or [`xr doctor`](../commands/doctor/), found at least one check item with the status `error`. `checks` lists every item as `{ "id", "status", "message"?, "fix"? }`, next to `error`. |
| `reserved-var-name` | `xr project create` or `xr project remove` found a `project.vars` name that starts with `CROSSREPO_`, in any case. The message names each name and its config file. Nothing changes. Run `xr codebase doctor`. |
| `lock-held` | Another `xr` command that changes files is running in this codebase. The message has its process ID (pid). Wait for it to end, then run the command again. `xr` does not wait or retry. |
| `interrupted` | You pressed Ctrl-C, or Ctrl-C or Escape in a picker. The steps that were done are undone. When an undo fails, or after a second Ctrl-C, `error.details.leftovers` lists each thing left as `{ "what", "path", "command" }`. `xr codebase clone`, `xr codebase pull` and `xr project sync` also put `repos` next to `error`: each repo done before Ctrl-C keeps its status, the repo that was running is `skipped` with the message `interrupted` when Ctrl-C stopped it (else it keeps its own result), and each repo not reached yet is `skipped` with the message `interrupted`. The exit code is 130. |

Warning codes, in `warnings`:

| Code | Meaning |
| --- | --- |
| `unknown-config-key` | A config file has a key that `xr` does not know. The hint names the closest known key. The command still runs. Doctor commands show these keys as checks instead, not as warnings. |
| `stale-lock` | The codebase lock belonged to a process that is not running any more, so `xr` took it over. The message has the old process ID. |
| `branch-not-merged` | `xr project remove --delete-branch` kept a branch because git says it is not merged. The hint has the `git branch -D` command to delete it anyway. The exit code stays 0. |
| `hook-failed` | A `post-remove` line of `xr project remove` failed, timed out, or was stopped by Ctrl-C, after the project was removed. `lines` has the last 20 lines of its output. The exit code stays 0. |

New commands add new codes. A script must handle a code that it does not know as a failure.

## Exit codes

| Exit code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | Any failure that is not a usage error or Ctrl-C. |
| `2` | A usage error: `usage` or `missing-argument`. |
| `130` | Ctrl-C (`interrupted`). |

## Lock and Ctrl-C

Commands that change files take a lock: the file `.crossrepo/xr.lock` in the codebase, with the process ID of the `xr` command in it. Only one such command can run in a codebase at a time. Another one fails at once with `lock-held`. Commands that only read, such as `xr config show`, take no lock. When the process in the lock is not running any more, for example after a crash, the next command takes the lock over and gives the `stale-lock` warning. A lock file with no valid process ID in it is taken over too, with no warning. A process ID that the system gave to a new process looks like a running command, so delete `.crossrepo/xr.lock` by hand only when you are sure no `xr` command runs.

Ctrl-C stops a command that changes files: it stops the step that runs, starts no new step, undoes the steps that are done, and exits with code 130 and the `interrupted` error. A step that deletes things for good, at the end of a remove, is not stopped: Ctrl-C takes effect after that step ends. Ctrl-C before the first step, for example while `xr` checks the repos, ends `xr` the default way: there is no JSON output and nothing is written. `xr codebase repo remove`, `xr project create` and `xr project remove` are different: Ctrl-C during their checks stops them, changes nothing, and exits with code 130 and `interrupted`. A second Ctrl-C stops the undo and exits at once. Then `error.details.leftovers` lists what is left, and the lock stays until the next command takes it over. `xr codebase clone` has no undo across repos: Ctrl-C stops the repo that runs and deletes its partial folder, and the repos done before stay. A second Ctrl-C during `xr codebase clone` exits at once and can leave the partial folder; the next `xr codebase clone` reports that repo as `folder has no .git`. `xr codebase pull` has no undo across repos either: Ctrl-C stops the repo that runs, and the repos done before stay pulled. The stopped repo is `interrupted` also when git had already pulled it, or had updated only part of it. It is safe to run `xr codebase pull` again.
