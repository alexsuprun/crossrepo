---
"crossrepo": patch
---

A folder delete now checks that the folder is gone and tries again up to 3 times. Before, `xr codebase repo remove` could report the folder as deleted while part of `.git` was still there. If the folder still exists after 3 tries, the delete fails and the folder is listed as left over.
