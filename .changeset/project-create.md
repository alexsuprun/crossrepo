---
"crossrepo": minor
---

Add `xr project create <branch> [<repo>...|--all]`, which makes one project folder with a git worktree of each chosen repo on the branch, writes `.crossrepo/project.yaml` and the project `AGENTS.md`, then runs each `post-create` line with `sh -c`. With no repos, a multi-select picker opens in a terminal. It checks everything first under the codebase lock; any later failure or Ctrl-C undoes all steps, and never deletes a branch that existed before. `project.vars` values can now be numbers and booleans, passed to hooks as text. New error codes: `project-exists`, `branch-in-use`, `no-default-branch`, `hook-failed` and `sh-not-found`.
