---
"crossrepo": minor
---

Add `xr codebase repo remove <name>`, which removes a repo from the codebase config and the `## Codebase` section of `AGENTS.md`, and deletes its folder. It first checks, under the codebase lock, that no project of the codebase uses the repo and that the folder has no uncommitted changes, unpushed commits or stashes; when a check fails, nothing changes. `--keep-folder` keeps the folder, and `--force` deletes it without the work check. A failed or stopped delete lists what is left with the commands to finish by hand. New error codes: `repo-not-found`, `repo-in-use`, `invalid-project-record` and `would-lose-work`. In JSON, `error.details` now also carries the plain data of an error, and a `value` field can be a boolean or a number.
