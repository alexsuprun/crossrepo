---
title: Output and errors
description: How xr prints results and errors, as text or as one JSON object, and which exit codes it uses.
---

Every `xr` command gives one result in one fixed shape. In a terminal you get readable text. With `--json` you get one JSON object that a script or an agent can read.

## Global flags

Every command accepts these 4 flags:

| Flag | Effect |
| --- | --- |
| `--codebase-path <path>` | Use the codebase at `<path>`. |
| `--json` | Print the result as one JSON object on stdout. `xr` never asks questions. |
| `--no-interactive` | Never ask questions. |
| `--verbose` | When `xr` crashes, print the stack trace on stderr. It changes nothing else. |

`xr` asks questions only when stdin and stdout are both a terminal, and neither `--json` nor `--no-interactive` is given.

## stdout and stderr

Progress goes to stderr: step lines, per-repo results and warnings. Only the final result goes to stdout. So you can pipe stdout to another program and still see the progress in the terminal.

## Output modes

`xr` picks a mode for stdout and for stderr, one at a time. It uses the first rule that matches:

1. `--json` gives `json` (stdout only).
2. `FORCE_COLOR` is set and is not `0`: `rich`.
3. `NO_COLOR` is set and is not empty: `plain`.
4. `TERM=dumb`: `plain`.
5. The stream is a terminal: `rich`.
6. Otherwise: `plain`.

`rich` text has colors. `plain` text has no escape codes. Each stream gets its own mode, so a piped stdout is `plain` while stderr in the terminal is `rich`. `FORCE_COLOR` wins over `NO_COLOR`, the same as in Node.

Both text modes use the same symbols:

| Symbol | Meaning |
| --- | --- |
| `✓` | done |
| `✗` | failed |
| `!` | warning |
| `–` | skipped |

## The JSON object

With `--json`, stdout is exactly one JSON object.

On success:

```json
{ "ok": true, "warnings": [], "version": "0.1.0" }
```

On failure:

```json
{
  "ok": false,
  "warnings": [],
  "error": {
    "code": "usage",
    "message": "unknown option '--nope'",
    "hint": "Run `xr --help` for usage."
  }
}
```

- `ok` is `true` on success and `false` on failure.
- `warnings` is always there. Each warning is `{ "code", "message", "hint"? }`. Each warning also goes to stderr when it happens.
- `error` is there only on failure. It has `code` and `message`, and `hint` and `details` only when the error has them.
- The other fields belong to the command. On failure they can be there too, next to `error`.

Read `error.code` to know what failed. Do not read the message or the exit code for this.

`--version` and `--help` follow `--json` too: `xr --json --version` prints `{"ok":true,"warnings":[],"version":"<version>"}`, and `xr --json --help` prints `{"ok":true,"warnings":[],"help":"<text>"}`.

Without `--json`, an error goes to stderr and stdout stays empty.

## Error codes

| Code | Meaning |
| --- | --- |
| `usage` | A bad flag, an unknown command or a missing option value. |
| `internal` | A bug in `xr`. Run the command again with `--verbose` and report the output on [GitHub](https://github.com/alexsuprun/crossrepo/issues). |

## Exit codes

| Exit code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | Any failure. |
| `2` | A usage error. |
