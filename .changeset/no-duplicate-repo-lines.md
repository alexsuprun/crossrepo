---
"crossrepo": patch
---

`xr codebase clone` and `xr codebase pull` no longer print each repo line twice. When stdout and stderr are both the terminal, the final result leaves out the per-repo lines that stderr already showed. On a failure, stderr no longer repeats the lines before the error. A piped stdout and `--json` still get the full list.
