---
"crossrepo": minor
---

Add a codebase lock and Ctrl-C undo. A command that changes files takes the lock `.crossrepo/xr.lock`, so a second such command in the same codebase fails at once with `lock-held`; a lock left by a process that is not running is taken over with a `stale-lock` warning. Ctrl-C during `xr codebase init` undoes the steps that are done and exits with code 130 and the `interrupted` error.
