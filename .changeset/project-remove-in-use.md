---
"crossrepo": patch
---

`xr project remove` now finishes when a program, such as a dev server, writes files in a worktree while git deletes it. Before, git failed with `Directory not empty` and left the project half-removed. Now `xr` deletes the rest of the folder and runs `git worktree prune`. A new warning, `programs-still-running`, lists the PID, command and folder of each program that still runs in a removed worktree. It uses `lsof` and is skipped on Windows or when `lsof` is not installed.
