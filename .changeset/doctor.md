---
"crossrepo": minor
---

Add `xr doctor`. It picks the checks from the folder: in a project folder (also one whose record is broken or whose codebase moved) it runs the checks of `xr project doctor` for that project, and in a codebase folder the checks of `xr codebase doctor`. The output and exit code are those of that command, after a leading `scope` value (`project` or `codebase`; JSON key `scope`). It takes no argument and opens no picker. In any other folder it fails with `not-a-codebase` and a hint to run it in a codebase folder or a project folder, or to give `--codebase-path`. It takes no lock and changes nothing.
