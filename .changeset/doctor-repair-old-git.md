---
"crossrepo": patch
---

`xr project doctor`: on git 2.27 and 2.28, the `git worktree repair` fix of `codebase-path` and `worktree-not-registered` now starts with "needs git 2.29 or newer (you have <version>):", because `git worktree repair` needs git 2.29.
