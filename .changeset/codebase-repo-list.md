---
"crossrepo": minor
---

Add `xr codebase repo list`, which prints each repo of the codebase with its remote, default branch and description, and whether its folder has a `.git`. It uses the merged config, so a `remote` in `config.local.yaml` wins. It works in a codebase or a project, changes nothing and takes no lock.
