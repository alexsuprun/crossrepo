---
"crossrepo": minor
---

Add `repos.<name>.always` to the config. `xr project create` adds each repo with `always: true` to the new project, and the picker shows it as already marked. `xr project doctor` warns with `always-repo-missing` when a project lacks such a repo.
