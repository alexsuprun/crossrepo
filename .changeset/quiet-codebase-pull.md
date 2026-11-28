---
"crossrepo": patch
---

`xr codebase pull` no longer prints git's own output. Each repo now gets one short line, such as `✓ api: 3 new commits`, `✓ web: up to date`, or `✗ cli: <git error>` with its hint. In JSON, the `message` of an `ok` repo is `N new commits`, `1 new commit` or `up to date`. Use the global `--verbose` flag to see git's full output as before; with `--json`, git's output is never shown.
