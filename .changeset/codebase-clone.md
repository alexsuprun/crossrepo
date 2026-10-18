---
"crossrepo": minor
---

Add `xr codebase clone`, which clones each repo of the codebase config that is not on disk yet, one at a time in config order, under the codebase lock. It uses the merged config, so a `remote` in `config.local.yaml` wins, and runs a plain `git clone`. A repo already on disk is skipped; a folder with no `.git` or a repo with no remote fails with a hint and is never touched. There is no undo across repos. New error code `repos-failed` (exit 1) when any repo fails. The `repos` list in JSON, next to `error` on a failure, has one `{ repo, status, message?, hint? }` item per repo; the new `hint` field says what to do for that repo. Ctrl-C stops the running clone, deletes its partial folder, marks it and the repos not reached as `skipped` with `interrupted`, and exits 130.
