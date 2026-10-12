# AGENTS.md

Instructions for AI agents working on crossrepo. These rules apply as code arrives in the repo.

## Commands

- `bun install`: install dev tools and turn on the pre-commit format check.
- `bun run validate`: run lint, typecheck, tests and the smoke tests in parallel. Run it before you finish a change. It prints one `name - ok` line for each check and hides their output. A failing check is marked `FAIL`, and its output follows the list. The other checks still run, so one run shows every problem. Flags: `--jobs N`, `--full` (do not cut a long failure), `--list`.
- `bun run validate:loud`: run the same checks one after another with all output, and stop at the first failure.
- `bun run lint`: lint and format check with Biome.
- `bun run format`: fix lint and format issues that Biome can fix.
- `bun run typecheck`: typecheck `src/` and, separately, `tests/` and `scripts/`.
- `bun run test`: run the unit, adapter and command tests with the coverage floor. It does not run smoke tests.
- `bun run test:unit`: run the tests in `tests/unit/`.
- `bun run test:adapters`: run the tests in `tests/adapters/`.
- `bun run test:commands`: run the tests in `tests/commands/`.
- `bun run test:smoke`: build `dist/xr.js`, then run the `*.smoke.ts` files in `tests/smoke/` against it under Node and under Bun.
- `bun run build`: bundle the CLI to `dist/xr.js`.

CI (`.github/workflows/ci.yml`) runs `lint`, `typecheck`, `test` and `test:smoke` on Linux, macOS and Windows. Set `XR_SMOKE_RUNTIMES=bun` (a comma list of `node` and `bun`; default both) to run the smoke tests under Bun only.

Renovate (`renovate.json`) updates dependencies, Action hashes and the Bun version. Do not bump pins by hand, and set the Bun version only in `packageManager` in `package.json`.

Tests and `scripts/` may use `Bun`. `src/` may not: a Biome rule on `src/` rejects the `Bun` global and imports of `bun` and `bun:*`.

For Conventional Commits, changesets and docs in the same pull request, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Layers

Code in `src/` follows this layer order:

```
cli → commands → services → domain + adapters
```

Each folder in `src/` is one layer. A layer may import only the layers in its row. Imports inside one layer are allowed, except that one command never imports another command.

| Layer | Folder | May import |
| --- | --- | --- |
| cli | `src/cli/` | commands, adapters, config, output, errors |
| commands | `src/commands/<group>/<command>` | services, runners, domain, errors (config and output only through `ctx`) |
| services | `src/services/` | other services (no cycles), domain, adapters, errors (config and output only through `ctx`) |
| runners | `src/runners/` | adapters, errors |
| domain | `src/domain/` | errors |
| adapters | `src/adapters/` | errors, and only `writeFileAtomic` from config |
| config | `src/config/` | nothing else from crossrepo |
| output | `src/output/` | nothing else from crossrepo |
| errors | `src/errors/` | nothing (leaf) |

- Only adapters, `config` and `output` import `node:fs` and `node:child_process`.
- `src/` uses `node:` APIs only, never `Bun`.
- `tests/unit/layers.test.ts` checks these rules on every import in `src/`.

## Tests

- Use test-driven development: write a failing test first, then the code that makes it pass.
- Tests have a coverage floor. Do not lower it.
- Tests live in one folder per level: `tests/unit/`, `tests/adapters/`, `tests/commands/` and `tests/smoke/`. Shared test code goes in `tests/helpers/`.
- Smoke test files are named `*.smoke.ts`, so `bun test` skips them. Run them with `bun run test:smoke`.

## Docs

User docs live only in `docs/src/content/docs/`, as plain Markdown. Do not copy them anywhere else.

`docs/` is its own package with its own `bun.lock`, outside Biome, the tsconfigs and `bun run validate`. Preview the site with `cd docs && bun install && bun run dev`.
