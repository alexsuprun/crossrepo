---
"crossrepo": minor
---

`xr project create` runs `project.pre-create` before it changes anything, and `xr project remove` runs `project.post-remove` after the project is gone. Both run in the codebase folder. A failed `pre-create` line stops the create with `hook-failed`. A failed `post-remove` line is a `hook-failed` warning with the hook output in a new `lines` field, and the remove still exits 0.
