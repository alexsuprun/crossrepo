---
"crossrepo": minor
---

Add `xr codebase pull`, which runs `git pull --ff-only --no-rebase` in each repo of the codebase config that is on disk, one at a time in config order, under the codebase lock. It pulls the checked-out branch from its own upstream, never switches branches, never rebases and never makes a merge commit. A missing repo is skipped with a hint to run `xr codebase clone`; a folder with no `.git` fails and is not touched. A repo that cannot be fast-forwarded, has no upstream, has a detached HEAD or has local changes in the way fails with git's message and a hint for the next step. There is no undo across repos. Any failed repo ends the command with `repos-failed` (exit 1). Ctrl-C stops the running pull, marks it and the repos not reached as `skipped` with `interrupted`, and exits 130.
