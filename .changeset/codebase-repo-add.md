---
"crossrepo": minor
---

Add `xr codebase repo add <url> [name]`, which clones a repo into the codebase, and `xr codebase repo add <folder>`, which adds a repo folder that is already directly in the codebase. Both add the repo at the end of `repos:` in the codebase config, keeping its comments and key order, and update the `## Codebase` section of `AGENTS.md`. The command takes the codebase lock; if a step fails or you press Ctrl-C, the done steps are undone and a folder that this run cloned is deleted. New error codes: `repo-exists` and `not-in-codebase`.
