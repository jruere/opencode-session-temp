# AGENTS.md

## Read first

- `README.md` is the design spec.
- `TESTING.md` is the test plan.
- Read `devenv.nix`, `package.json`, and `tsconfig.json` for the toolchain and git-hook setup. This file records only
  what is easy to miss.

## Environment

- When `DEVENV_ROOT` is set, the devenv shell is active. Run tools directly, not through `devenv shell`.
- Use npm, not pnpm or yarn. `node_modules` is not committed.
- Do not float `@opencode/plugin`; it must match the target OpenCode server.
- `.pre-commit-config.yaml` is a generated symlink into the Nix store and is gitignored. Never edit it; change
  `devenv.nix`.

## Verification

- Run `devenv test` for every verification pass. It runs `enterTest` commands and pre-commit hooks on all files, staged
  or not, including tests, linters, and formatters.
- Do not run `npm test`, `npm run test:live`, `npm run typecheck`, `biome`, or individual hook commands as a substitute
  for `devenv test`. They are not equivalent: they skip the configured hooks and their order. Run one of them
  only to debug a failure that `devenv test` already reported or for non-tracked files.
- `devenv test` prints `devenv:enterTest (no command)` even when `enterTest` runs. Treat that label as cosmetic;
  the command still executes.
- Tests use `node:test`. Each test is three paragraphs: setup, execution, assertions. Assign the value being tested to
  `subject`. Name tests `when_{scenario}_then_it_{expected outcome}`.
- Live checks use the `*.live.ts` suffix and run with `npm run test:live`; `npm test` skips them.

## Architecture constraints

- Target OpenCode V2: import `Plugin` from `@opencode/plugin`, not `@opencode-ai/plugin`.
- Scratch directories are per session at `<root>/<project-slug>/<sessionID>`. Do not introduce a shared directory or a process-wide `TMPDIR`.
- Enforce writes in `ctx.permission.hook("evaluate")` for `edit`/`write`/`patch`; keep reads open. Shell is deliberately not intercepted.
- Module layout: `src/index.ts` wiring, `src/layout.ts` paths, `src/instructions.ts` context rewrite,
  `src/enforce.ts` permissions, `src/sweep.ts` cleanup and lifecycle.
