---
"crossrepo": minor
---

`xr project repo add` and `xr project repo remove` run the new `pre-repo-add`, `post-repo-add`, `pre-repo-remove` and `post-repo-remove` hooks, and every hook gets `CROSSREPO_REPOS`, the repos the command adds or removes.
