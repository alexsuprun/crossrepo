---
"crossrepo": minor
---

Add interactive pickers to `xr codebase repo add` and `xr codebase repo remove`. With no argument, in a terminal, `repo add` lets you pick a repo folder of the codebase that is not in the config yet, and `repo remove` lets you pick a repo of the codebase config; the picker shows on stderr, and Ctrl-C or Escape stops the command with `interrupted` (exit 130) and changes nothing. With no terminal, `--json` or `--no-interactive`, or when there is nothing to pick, a missing argument now fails with the new code `missing-argument` (exit 2) instead of `usage`; the message lists the choices, and `error.details` is `{ argument, choices }`.
