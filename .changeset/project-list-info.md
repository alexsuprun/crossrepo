---
"crossrepo": minor
---

Add `xr project list` and `xr project info [<project>]`. `list` prints each project of the codebase in name order, with its branch, created date and repos; `info` prints one project, found by folder name or branch, with its path, codebase, created time and whether each worktree folder exists. In a project folder, `info` with no argument shows that project; in a codebase folder it fails with `missing-argument` and lists the projects, with no picker. Both read only: no lock and no git command. A project record that is not valid is a warning `invalid-project-record` there, and the other projects still show. New error code `project-not-found` (exit 1).
