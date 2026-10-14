# crossrepo

## 0.1.0

### Minor Changes

- [#46](https://github.com/alexsuprun/crossrepo/pull/46) [`35291d6`](https://github.com/alexsuprun/crossrepo/commit/35291d65306a7fe49e0b64d1976fc4d7d0507f97) Thanks [@alexsuprun](https://github.com/alexsuprun)! - Add `xr codebase init`, which makes a folder of sibling git repos into a codebase. It records the `origin` remote and the default branch of each repo in `.crossrepo/config.yaml` and writes the `## Codebase` section of `AGENTS.md`. If a step fails, the done steps are undone.

- [#49](https://github.com/alexsuprun/crossrepo/pull/49) [`0caad61`](https://github.com/alexsuprun/crossrepo/commit/0caad61b4acdb54c99dff0c9046b1ac6c010beb4) Thanks [@alexsuprun](https://github.com/alexsuprun)! - Add `xr codebase repo add <url> [name]`, which clones a repo into the codebase, and `xr codebase repo add <folder>`, which adds a repo folder that is already directly in the codebase. Both add the repo at the end of `repos:` in the codebase config, keeping its comments and key order, and update the `## Codebase` section of `AGENTS.md`. The command takes the codebase lock; if a step fails or you press Ctrl-C, the done steps are undone and a folder that this run cloned is deleted. New error codes: `repo-exists` and `not-in-codebase`.

- [#48](https://github.com/alexsuprun/crossrepo/pull/48) [`574921e`](https://github.com/alexsuprun/crossrepo/commit/574921ebc20c89412dc48ce7e453a3b60a48b06e) Thanks [@alexsuprun](https://github.com/alexsuprun)! - Add `xr codebase repo list`, which prints each repo of the codebase with its remote, default branch and description, and whether its folder has a `.git`. It uses the merged config, so a `remote` in `config.local.yaml` wins. It works in a codebase or a project, changes nothing and takes no lock.

- [#50](https://github.com/alexsuprun/crossrepo/pull/50) [`1a4afe6`](https://github.com/alexsuprun/crossrepo/commit/1a4afe6d923f31af7f18c6ea29dfbf3616e1feb3) Thanks [@alexsuprun](https://github.com/alexsuprun)! - Add `xr codebase repo remove <name>`, which removes a repo from the codebase config and the `## Codebase` section of `AGENTS.md`, and deletes its folder. It first checks, under the codebase lock, that no project of the codebase uses the repo and that the folder has no uncommitted changes, unpushed commits or stashes; when a check fails, nothing changes. `--keep-folder` keeps the folder, and `--force` deletes it without the work check. A failed or stopped delete lists what is left with the commands to finish by hand. New error codes: `repo-not-found`, `repo-in-use`, `invalid-project-record` and `would-lose-work`. In JSON, `error.details` now also carries the plain data of an error, and a `value` field can be a boolean or a number.

- [#42](https://github.com/alexsuprun/crossrepo/pull/42) [`b508db3`](https://github.com/alexsuprun/crossrepo/commit/b508db3fe2dc84f7d4db28fd9c3ac472f1926d3c) Thanks [@alexsuprun](https://github.com/alexsuprun)! - Add `xr config show`, which prints the merged config and the file that gives each value. `projects-dir` now defaults to `.projects`. Unknown config keys give a warning with a "did you mean" hint.

- [#47](https://github.com/alexsuprun/crossrepo/pull/47) [`7fa2fad`](https://github.com/alexsuprun/crossrepo/commit/7fa2fad91887f6dd23ec3911a46b30e58fd72117) Thanks [@alexsuprun](https://github.com/alexsuprun)! - Add a codebase lock and Ctrl-C undo. A command that changes files takes the lock `.crossrepo/xr.lock`, so a second such command in the same codebase fails at once with `lock-held`; a lock left by a process that is not running is taken over with a `stale-lock` warning. Ctrl-C during `xr codebase init` undoes the steps that are done and exits with code 130 and the `interrupted` error.

- [#40](https://github.com/alexsuprun/crossrepo/pull/40) [`0d41226`](https://github.com/alexsuprun/crossrepo/commit/0d41226a13ee7c4a2b356b5463388b7c9ff30054) Thanks [@alexsuprun](https://github.com/alexsuprun)! - Add one output shape for every result and error: readable text in a terminal, or one JSON object on stdout with `--json`, including for `--help` and `--version`. Add the `--verbose` flag, which prints the stack trace of an internal error.

## 0.0.1

### Patch Changes

- [#27](https://github.com/alexsuprun/crossrepo/pull/27) [`a1845e0`](https://github.com/alexsuprun/crossrepo/commit/a1845e0f221fb5035ea8e4a25763e67f742ccb2a) Thanks [@alexsuprun](https://github.com/alexsuprun)! - Releases are now published from CI with npm provenance, so each version links to the commit it was built from.
