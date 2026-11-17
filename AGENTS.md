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

- Project operations are defined in both `devenv.nix` (devenv tasks) and `package.json` (npm scripts). Keep them in
  sync: same commands, globs, and coverage thresholds.
- Run `devenv test` for every verification pass. It runs `test:typecheck`, `test:unit`, and the pre-commit hooks on
  all files, staged or not, including tests, linters, and formatters.
- The npm scripts (`npm test`, `npm run test:typecheck`, `npm run test:live`, `npm run test:coverage`, `npm run check`)
  are convenience entry points. They do not run the git hooks, so they are not a substitute for `devenv test`.
- Do not run `node --test`, `tsc --noEmit`, `biome`, or individual hook commands as a substitute for `devenv test`
  either. They are not equivalent: they skip the configured hooks and their order. Run one only to debug a failure
  that `devenv test` already reported or for non-tracked files.
- `devenv test` prints `devenv:enterTest (no command)`; that label is cosmetic.
- Test style, naming, and the live-check conventions are in `TESTING.md`.

## Architecture constraints

- Target OpenCode V2: import `Plugin` from `@opencode/plugin`, not `@opencode-ai/plugin`.
- Scratch directories are per session at `<root>/<project-slug>/<sessionID>`. Do not introduce a shared directory or a process-wide `TMPDIR`.
- Enforce writes in `ctx.permission.hook("evaluate")` for `edit`/`write`/`patch`; keep reads open. Shell is deliberately not intercepted.
- Module responsibilities are listed in `README.md` under Development. Update that list when a module changes; do not
  restate it here.
