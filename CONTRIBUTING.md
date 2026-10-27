# Contributing to crossrepo

Thanks for your interest in crossrepo. This guide explains how to contribute.

## Setup

1. Install [Bun](https://bun.sh) at the version in `packageManager` in `package.json`.
2. Run `bun install`. This installs the dev tools and turns on the pre-commit hook in `.githooks/`, which rejects a commit when a staged file is not formatted. Run `bun run format` to fix the format.
3. Run `bun run validate`. It runs lint, typecheck, tests and the build. Run it before you open a pull request.

## Test scripts

- `bun run test`: run all tests except smoke tests, with the coverage floor.
- `bun run test:unit`: run the tests in `tests/unit/`.
- `bun run test:adapters`: run the tests in `tests/adapters/`.
- `bun run test:commands`: run the tests in `tests/commands/`.
- `bun run test:smoke`: build `dist/xr.js`, then run the smoke tests (`tests/smoke/*.smoke.ts`) against it under Node and under Bun. Node and Bun must both be installed.

## Open an issue first for big changes

For a big change, open an issue first and describe what you want to do. This lets us agree on the approach before you write code. Small fixes, such as typos, can go straight to a pull request.

## Tests first (TDD)

Write a failing test first, then the code that makes it pass. A bug fix starts with a test that reproduces the bug.

## Conventional Commits

Use [Conventional Commits](https://www.conventionalcommits.org/) such as `feat: ...`, `fix: ...` or `docs: ...`. Pull requests are squash merged and the PR title becomes the commit message, so the PR title is checked.

## CI

Every pull request runs CI. On Linux, macOS and Windows: `checks` (lint, typecheck, unit, adapter and command tests), `smoke` (smoke tests under Node 22.13, Node 24 and Node 26), `e2e` (packs the package, installs it with `npm i -g` under Node 22.13, and runs `xr codebase init`, `xr project create` and `xr project remove` with `tests/e2e/round-trip.ts`) and `bun-only` (the bundle under the pinned Bun and Bun 1.3.0 with Node removed from PATH). On Linux only: `docs build` (builds the docs site), `git-floor` (command and smoke tests under git 2.27.0, built from source) and `pr-title`. All of them must pass before merge.

## Dependency updates

[Renovate](https://docs.renovatebot.com/) keeps dev dependencies, GitHub Action hashes and the Bun version in `packageManager` up to date (see `renovate.json`). Every Monday it opens grouped pull requests with the `dependencies` label: one for all minor and patch updates, one for each major update, one for Bun and one for the docs site in `docs/`. The "Dependency Dashboard" issue lists pending and upcoming updates. You do not need to bump these by hand.

## Changesets

Every pull request adds one changeset. A changeset is a small file in `.changeset/` that says which version bump the change needs and describes it for the changelog.

- Run `bunx changeset`, pick the bump (`patch`, `minor` or `major`) and write one line for users. Commit the new file with your change.
- For a change that users do not see, such as docs-only or CI-only changes, run `bunx changeset --empty`. It adds a changeset with no bump.
- Renovate pull requests need no changeset. Updated bundled libraries reach users with the next release that has a real change, and the changelog does not list them. When an update fixes a real bug for users, the maintainer may add a changeset to that Renovate pull request.
- The `chore: version packages` pull request needs no changeset.

The [changeset-bot](https://github.com/apps/changeset-bot) comments on a pull request that has no changeset. The comment is a reminder only and does not block the merge.

### How a release happens

1. A pull request with a changeset is merged into `master`.
2. The release workflow (`.github/workflows/release.yml`) opens or updates the `chore: version packages` pull request. It bumps the version in `package.json` and `.claude-plugin/plugin.json`, and adds the entry to `CHANGELOG.md`.
3. The maintainer reviews and merges that pull request.
4. The release workflow publishes the new version to npm with provenance, creates the `vX.Y.Z` tag and the GitHub Release, and then installs the published version with npm, Bun and `bunx` to check that `--version` works.

Publishing uses npm Trusted Publishing, so there is no npm token.

## Docs in the same pull request

User docs live in `docs/src/content/docs/`. When your change affects users, update the docs in the same pull request.

The docs site is published at <https://alexsuprun.github.io/crossrepo/>. To preview it locally:

```sh
cd docs && bun install && bun run dev
```

## Where to ask

Ask questions in [GitHub Discussions](https://github.com/alexsuprun/crossrepo/discussions).

## No CLA

There is no contributor license agreement. By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
