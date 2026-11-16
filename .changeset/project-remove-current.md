---
"crossrepo": patch
---

`xr project remove` with no project, run in a project folder, now removes that project. Before, it opened the project picker, or failed with `missing-argument` when not interactive. In a terminal it first asks `Remove the project <name>?`, default No; No, Ctrl-C or Escape stop it with `interrupted` (exit code 130) and change nothing. With `--json` or `--no-interactive` it removes the project with no question. In a codebase folder, the picker works as before.
