---
"crossrepo": minor
---

Add `xr codebase init`, which makes a folder of sibling git repos into a codebase. It records the `origin` remote and the default branch of each repo in `.crossrepo/config.yaml` and writes the `## Codebase` section of `AGENTS.md`. If a step fails, the done steps are undone.
