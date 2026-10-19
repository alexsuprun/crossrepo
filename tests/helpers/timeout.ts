import { setDefaultTimeout } from "bun:test";

// Real git calls on Windows runners often go over the 5 s default, in tests and in hooks.
// bunfig.toml has no `timeout` key, and `--timeout` would have to be on every test script.
setDefaultTimeout(30_000);
