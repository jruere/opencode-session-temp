# AGENTS.md

## Read first

- `README.md` is the design spec and the only documentation. Most of it describes planned behavior, not existing code.
- Read `devenv.nix` for the toolchain and git-hook setup. This file records only what is easy to miss.

## Current state

- No `package.json`, `src/`, test files, or CI exist. Do not assume npm scripts or entrypoints.

## Environment

- When `DEVENV_ROOT` is set, the devenv shell is active. Run `node`, `npm`, `tsc`, and `biome` directly, not through `devenv shell`.
- Use npm, not pnpm or yarn.
- `.pre-commit-config.yaml` is a generated symlink into the Nix store and is gitignored. Never edit it; change `devenv.nix`.

## Verification

- Run `devenv --no-tui test`. It runs tests, linters, and formatters via the pre-commit hooks.
- `devenv test` prints `devenv:enterTest (no command)` even when `enterTest` runs. Treat that label as cosmetic; the command still executes.
- Tests use `node:test`. Each test is three paragraphs: setup, execution, assertions. Assign the value under test to `subject`. Name tests `test_when_{scenario}_then_it_{expected outcome}`.

## Architecture constraints

- Target OpenCode V2: import `Plugin` from `@opencode/plugin`, not `@opencode-ai/plugin`.
- Scratch directories are per session at `<root>/<project-slug>/<sessionID>`. Do not introduce a shared directory or a process-wide `TMPDIR`.
- Enforce writes in `ctx.permission.hook("evaluate")` for `edit`/`write`/`patch`; keep reads open. Shell is deliberately not intercepted.
- Planned modules: `src/index.ts` wiring, `src/layout.ts` paths, `src/instructions.ts` context rewrite, `src/enforce.ts` permissions, `src/sweep.ts` cleanup and lifecycle.
