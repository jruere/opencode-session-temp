# Implementation plan

The README is the specification and the oracle for every test. This plan turns it into small, testable slices so each
milestone ends with behavior covered by tests instead of a big-bang implementation.

Working agreement:

- One module per milestone. Write the suite first, watch it fail, implement, then run `devenv test`.
- Never let a test touch `path.join(os.tmpdir(), "opencode")`. Every filesystem test gets its own root.
- Keep commits at green milestones. There is no CI yet, so a commit is the rollback point.

## Contract notes verified against `@opencode/plugin` 2.2.6

These affect the adapter shape, so they are fixed before writing tests.

| Fact | Consequence |
| --- | --- |
| `session.hook` and `permission.hook` return `Promise<Registration>` | `setup` collects registrations; cleanup disposes all of them |
| `ctx.event.subscribe({ types, signal })` returns an `AsyncIterable` | lifecycle is an async loop, not a callback registration; stop it with an `AbortController` |
| `session.get({ sessionID })` returns `Session.Info` with `location.directory` and `projectID` | resolve the session's own layout from `session.get`, never from `ctx.location` |
| `SystemPart.metadata` is `Record<string, unknown>`; the instructions entry is `{ key, text }` | narrow it with a type guard; never rewrite the metadata copy |
| `Permission.Effect` is `"allow" \| "deny" \| "ask"` | mode maps directly onto the hook's `effect` |
| `permission.hook` is `Hooks`, not `ModelHooks` | no provider option is involved |
| `PluginOptions` is `Readonly<Record<string, any>>` | parse and validate in one place; do not sprinkle casts |
| `Plugin.Context` has no `logger` | define `Logger` in the plugin, inject it into modules, and default to `console` in `setup` |

## Pinned decisions from "Open decisions to pin with a test"

Confirm or override these before M1. Each gets a test and a README sentence.

| # | Question | Decision | Why |
| --- | --- | --- | --- |
| 1 | Loose file directly under the scratch root or directly under a project directory | Leave it untouched. It is inside the root but not inside any session directory. `external_directory` still auto-allows it. | The README only names other session directories, and the root is shared with other tools |
| 2 | Symlink inside the own directory pointing at another session | Classify lexically with `path.resolve`, no `realpath` on resource targets. The own directory wins for any lexical descendant. | Security isolation is a non-goal; resolving would make the pure decision filesystem-bound and block legitimate links |
| 3 | `atime` on `noatime` or `relatime` mounts | Require both `atime` and `mtime` to be strictly older than the cutoff. No touch-on-use. | Matches the README and keeps `sweepOnce` read-only; document the relatime caveat |
| 4 | Invalid options | Reject during `setup` with an `Error` naming the option and the bad value. No silent fallback. | Silently ignoring `enforce` or `root` would defeat the plugin's only enforcement |
| 5 | Long project slug | Last two segments, stripped and capped at 48 chars, plus `-` and 7-char base32(CRC32(projectID + NUL + normalized directory)); `/` is `root`, an empty result is `project`. | Bounded 56-byte segment; the checksum disambiguates shared tails and stripped characters. |

Three smaller decisions to pin while implementing:

- The cutoff is strict: a file is stale when `max(atime, mtime) < now - maxAgeHours`. An entry exactly at the cutoff
  is kept, and a fresh `atime` with a stale `mtime` (or the reverse) is kept, per README and TESTING.md.
- `isInside(parent, child)` is segment-aware via `path.relative`, returns false for the parent itself, and true for
  strict descendants. The session directory uses the same predicate against its project directory.
- A warning is logged once per plugin instance per warning kind (missing source, replacement miss, mkdir failure,
  rename failure), never once per module or process.

## Target module APIs

Signatures are deliberately narrow so the suites can call the pure part without a fake context.

```ts
// src/layout.ts
export function isInside(parent: string, child: string): boolean;
export function projectSlug(directory: string, projectID: string): string;
export function sessionSegment(sessionID: string): string;
export function resolveLayout(
  root: string,
  session: { sessionID: string; projectID?: string; location?: { directory?: string } },
): { projectSlug: string; projectDir: string; sessionDir: string };
```

```ts
// src/enforce.ts
export function evaluateEdit(input: {
  root: string;
  ownDir: string;
  resources: readonly string[];
  mode: "deny" | "ask";
}): { effect: "deny" | "ask"; message: string } | undefined;
export function evaluateExternal(input: {
  root: string;
  resources: readonly string[];
  allowExternal: boolean;
}): { effect: "allow" } | undefined;
```

```ts
// src/instructions.ts
export function rewriteInstructions(
  parts: Array<{ type: string; text: string; metadata?: Record<string, unknown> }>,
  defaultRoot: string,
  sessionDir: string,
): boolean;
```

```ts
// src/logging.ts
export type Logger = {
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
};
export type WarnKind = "missing-source" | "replacement-miss" | "mkdir" | "rename";
export interface WarnState { readonly warned: Set<string>; }
export function warnOnce(state: WarnState, kind: WarnKind, logger: Logger, message: string, ...args: unknown[]): void;

// src/fs-errors.ts
export function isMissing(error: unknown): boolean;
export function isNotEmpty(error: unknown): boolean;
export function isDestinationExists(error: unknown): boolean;
```

```ts
// src/sweep.ts
export function isStale(stats: { atimeMs: number; mtimeMs: number }, cutoffMs: number): boolean;
export function sweepOnce(root: string, options: { maxAgeHours: number; now: number; logger: Logger }): Promise<void>;
export function startSweepTimer(sweep: () => Promise<void>, intervalMs: number, logger: Logger): { stop: () => void };
```

```ts
// src/lifecycle.ts
export type LifecycleEvent = /* deleted | archived | moved, with the fields the handlers read */;
export function subscribeLifecycle(events: AsyncIterable<LifecycleEvent>, deps: LifecycleDeps): Promise<void>;
```

`logging.ts` and `fs-errors.ts` are leaf modules shared by `sweep.ts`, `lifecycle.ts`, and `instructions.ts`.
`index.ts` owns option parsing, the per-instance memo, warn flags, per-session `enrichmentDisabled` state,
registrations, the abort controller, and the timer. Lifecycle handlers live in `lifecycle.ts`; `lifecycle.test.ts`
is their suite. `LifecycleEvent` is narrowed to the fields the handlers read, so the M6 `ctx.event.subscribe`
result must stay assignable to it and an upstream field rename fails the type check.

## Milestones

| # | Deliverable | Tests | Done when |
| --- | --- | --- | --- |
| M0 | `test/helpers/tmp-root.ts`, `test/helpers/fake-context.ts`, `test/fixtures/environment-part.ts`, throwing stubs for the `src/layout.ts` exports | helper self-check in `plugin.test.ts` later; no red suite yet | `tsc --noEmit` passes with the helpers and a first failing `layout` test |
| M1 | `src/layout.ts`: normalization, slug, hash, validation, fallback | `layout.test.ts`: the table cases plus the two property invariants | layout suite green; `plugin.test.ts` still absent |
| M2 | `src/enforce.ts`: pure decision plus thin adapter | `enforce.test.ts`: action/resource/mode/`allowExternal` table, multiple resources, traversal, message | enforce suite green |
| M3 | `src/instructions.ts`: pure rewrite plus adapter | `instructions.test.ts`: selection, exact replacement, prefix collision, idempotence, stability, both fallbacks, mkdir failure, metadata immutability | instructions suite green; adapter consumes an injected layout resolver |
| M4 | `src/sweep.ts`: age predicate, real-tree sweep, timer | `sweep.test.ts`: stale/fresh/boundary, symlink project, non-`ses` dir, loose file, symlink target, FIFO, pruning, missing root, race, partial failure | sweep suite green |
| M5 | `src/lifecycle.ts`: lifecycle handlers and subscription loop | `lifecycle.test.ts`: deleted, duplicate, disabled, archived, moved, move destination exists, move race, move failure, cleanup | lifecycle suite green |
| M6 | `src/index.ts`: options, memo, wiring, cleanup | `plugin.test.ts`: registrations, defaults and overrides, `enforce: "off"`, `allowExternal: false`, disposal, memoization, move invalidation, concurrency, no shell hook | plugin suite green; full `npm test` green |
| M7 | Live checks, coverage, docs | `test/live/*.live.ts`; coverage run; README decision sentences | `npm run test:live` passes against a local server; coverage >= 80% |

### M0: harness (DONE)

- `tmp-root.ts`: `mkdtemp` under `os.tmpdir()`, `realpath`, register `t.after` removal, expose `root` and helpers to
  build project and session trees. Realpath matters on macOS.
- `fake-context.ts`: implements only `location`, `options`, `session.get`, `session.hook`, `permission.hook`,
  `event.subscribe`. It records every registration, returns a disposable registration, and exposes `fire(name, event)`
  and `push(event)`. The unavoidable `as unknown as Plugin.Context` cast lives here and nowhere else.
- `environment-part.ts`: one minimal `core/environment` system part with the default root in its text and a
  `{ key, text }` metadata entry (matching `metadata.experimental.instructions` as used by core). Pin it once; let the
  live check find upstream drift.
- `src/layout.ts` exports exist as throwing stubs so `tsc --noEmit` passes before M1 replaces them.

### M1: layout (DONE)

Start with the shared-last-two-segments test (`/a/b/c` versus `/x/b/c`), then add the rest of the `TESTING.md`
table. Implement in this order:

1. `sessionSegment`: validate `^ses[A-Za-z0-9._-]+$`, reject empty, `.`, and `..`; fall back to a sanitized form plus
   `-` and the first 8 hex of `sha256(original)`.
2. `slugSegment` and `slugHash`: `slugSegment` removes `.`, `_`, and whitespace anywhere, replaces any remaining
   character outside `[A-Za-z0-9-]` with `-`, collapses `-` runs, and trims `-`. `slugHash(projectID, normalized)` is
   `zlib.crc32(Buffer.from(projectID + "\0" + normalized, "utf8"))` encoded as 4 bytes big-endian and then lowercase
   RFC 4648 base32 without padding (7 characters).
3. `projectSlug`: normalize with `path.resolve` into `normalized` and use it for both the readable part and the hash.
   If `normalized` equals `path.parse(normalized).root`, use `root`. Otherwise take
   `path.basename(path.dirname(normalized))` and `path.basename(normalized)`, map each through `slugSegment`, drop
   empties, join with `_`, keep the last 48 characters, trim `-` and `_` from both ends, and use `project` when
   empty. Append `-${slugHash(projectID, normalized)}`.
4. `isInside` with `path.relative` plus `..` and absolute-result checks.
5. `resolveLayout`: root, project, session directory; fallback `global/<sessionSegment(sessionID)>` when location or
   project is unusable, so an unsafe `sessionID` cannot inject path segments.

Property tests use a small deterministic generator (no dependency): pairs of valid session IDs and project paths, then
assert strict descendant and mutual non-containment.

### M2: enforcement (DONE)

Write the shared-prefix test first (`ses_A` versus `ses_AB`). Then:

- `evaluateEdit` normalizes resources with `path.resolve` against `process.cwd()` only for relative inputs, classifies
  root containment first, own directory second, foreign session directory third. Everything else is untouched.
- Foreign means inside a session directory under the root that is not the own directory, including descendants.
  A loose file directly under the root, or directly under a project directory, is untouched by design.
- One foreign resource is enough. The returned message names the own directory and the offending path, for example:
  `Session ses_A may only write inside /tmp/opencode/proj/ses_A; /tmp/opencode/proj/ses_B/notes.txt belongs to another session.`
- The adapter reads the mutable event, calls the pure function, and writes `effect` and `message` only.
- `external_directory` adapter sets `effect = "allow"` when `allowExternal` and any resource is inside the root.
- Per-session `enrichmentDisabled` is checked by the wiring in M6: when set for a session, `edit` enforcement for that
  session is skipped.

### M3: instructions (DONE)

Test selection and both fallback branches before the adapter. Implementation order:

1. Type guard for `metadata.experimental.instructions`; match the `core/environment` source entry (by `key` when
   present, otherwise by text match) and locate the corresponding system part. Pin the exact metadata shape against
   `@opencode/plugin` 2.2.6 in the M0 fixture.
2. Idempotence check first, across the whole `parts` array: return `false` if any text part already contains the
   session directory. This covers the fallback appends too, so a repeated call on the same array does not append a
   second copy.
3. Replace the exact default root in `part.text` with boundary guards on both sides, so `/tmp/opencode-other` and
   `/x/tmp/opencode` are untouched. Preserve all other text in the part.
4. If no source part or no replacement, append one stable text part containing the session directory. The same text is
   appended every time, so the prompt cache is not invalidated. Return `true`.
5. The adapter resolves the directory via the injected session resolver and creates it with
   `mkdir({ recursive, mode: 0o700 })`. The mkdir result is cached per session in memory (README: "Cache the result per
   session"), including failures: a cached failure means the adapter leaves the parts untouched and
   `enrichmentDisabled` stays set. Both the mkdir cache entry and `enrichmentDisabled` are cleared on `session.moved`
   and `session.deleted`.
6. Never mutate `metadata`; copy only `text`.

The fixture is minimal, not core's prose. The live check covers drift.

### M4: sweep (DONE)

Use a fixed `now` and `fs.utimes`. Implement bottom-up pruning so a session directory is removed only after its stale
children are gone. Keep the root itself. Skip symlinked project directories and non-`ses` names entirely. Treat
`ENOENT` as success everywhere. Staleness is `max(atimeMs, mtimeMs) < cutoffMs` where
`cutoffMs = now - maxAgeHours * 3_600_000`.

For races, spy on `fs.promises.lstat` or `fs.promises.rename` and delete the target between scan and action. Test
`sweepOnce` directly with the `PLAN.md` signature (note `TESTING.md` line 44 shows an older `sweepOnce(root, options, now)`
shape; keep the tests aligned with this plan); test `startSweepTimer` only for interval registration, `unref`, and `stop`.

### M5: lifecycle (DONE)

Implement the handlers in `src/lifecycle.ts` and put them behind `subscribeLifecycle(events, deps)` so tests can
drive a homemade async iterable without a transport. `index.ts` only supplies `ctx.event.subscribe({ types, signal })`.

- `deleted`: scan every project directory (skipping symlinked project directories) for `<sessionSegment(sessionID)>`,
  remove matches recursively, ignore `ENOENT`, and clear per-session memo, mkdir cache, and `enrichmentDisabled` state.
- `archived`: no-op by default; remove when `cleanupOnArchive` (same scan/remove behavior as delete).
- `moved`: compute the new project directory and slug via `resolveLayout(root, { sessionID, projectID:
  event.data.projectID, location: event.data.location })`, so the same normalization applies. Find the old directory
  by scanning for `<sessionSegment(sessionID)>`. If old and new paths are identical, return after clearing memo/mkdir
  cache/`enrichmentDisabled`. Otherwise `mkdir` the new project directory, then rename. If the destination exists, move
  entries one by one and skip clashes. Ignore `ENOENT`. Any other rename failure is logged and does not throw. Memo,
  mkdir cache, and `enrichmentDisabled` are cleared in all cases.
- Cleanup aborts the controller and awaits the loop's termination. The loop tolerates abort between events and treats
  `AbortError` as normal termination.

### M6: wiring

Implement option parsing and validation first, then the resolver, then registrations.

- `parseOptions(ctx.options)`: defaults from the README, reject invalid values, resolve `root` absolute, and realpath
  the resolved `root` once when possible to handle `/tmp` -> `/private/tmp` mismatches on macOS.
- `createSessionResolver`: `Map<sessionID, Promise<SessionLayout>>`, one `session.get` call per session, concurrent
  callers share the promise. A rejected lookup is removed from the map. `session.moved` and `session.deleted` clear the
  entry, the mkdir cache, and per-session `enrichmentDisabled` state.
- Register `session.context` always. When the session has a cached mkdir failure (`enrichmentDisabled`), the hook
  returns the parts untouched (README: "leave the instructions untouched").
- Register one `permission.evaluate` hook when `enforce !== "off"` or `allowExternal` is true. The callback switches on
  `input.action`: handle `edit` only when `enforce !== "off"` and the session is not `enrichmentDisabled`; handle
  `external_directory` only when `allowExternal` is true.
- Register lifecycle handlers (always, so `session.moved` and enabled delete/archive cleanup work regardless of
  `enforce`), start the sweep timer when `sweep` is true, and run one immediate sweep (started from `setup`; errors are
  logged and must not reject setup).
- Return one cleanup that disposes every registration in reverse order, aborts the subscription, awaits lifecycle loop
  termination, and stops the timer.
- Do not touch `shell.create.before` or any environment variable. `plugin.test.ts` asserts the absence of a shell hook.

### M7: live and polish

- `test/live/instructions.live.ts`: load a probe plugin after this one, inspect the rewritten parts, persist them, and
  assert the directory is present, byte-identical on the next call, and changed after a move. No model needed.
- Stretch: `test/live/write.live.ts` with a local OpenAI-compatible stub, per `TESTING.md` check 2. If it becomes
  expensive to maintain, keep the probe check and move the write check to the manual checklist.
- Run coverage once all suites exist, then trim only defensive logging and timer wiring from the untested remainder.
  There is no coverage exclusion config: `package.json` enforces 80% lines, functions, and branches globally across
  `src/**`, so the untested remainder must fit inside that 20% budget or get tests.
- README/TESTING updates: add the remaining pinned decisions where the behavior is described, fix the warning scope
  sentence (README line 75: "once per process" -> "once per plugin instance"), and remove the decisions from the
  `TESTING.md` open list.

## First six tests

In milestone order:

1. `when_resource_is_a_sibling_with_a_shared_prefix_then_it_is_treated_as_foreign`
2. `when_default_path_is_a_prefix_of_another_path_then_it_rewrites_only_the_exact_path`
3. `when_context_hook_runs_twice_then_it_is_byte_identical`
4. `when_project_ids_differ_then_it_gives_different_slugs`
5. `when_atime_is_fresh_and_mtime_is_stale_then_it_keeps_the_file`
6. `when_two_sessions_share_a_filename_then_it_denies_the_cross_write`

Tests 1-5 live in their milestone suites (M2, M3, M1, M4). Test 6 belongs to `plugin.test.ts` (M6) and is the first
integration-shaped test. It uses two session IDs, one fake context, and the real permission adapter, not a live server.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| `devenv test` runs hooks on every file, so a half-written file fails the pass | Commit only at green; keep work-in-progress unstaged, hooks still check it, so format before the pass |
| The fake context drifts from core and hides silent enforcement failure | Keep one live probe check and the typed cast boundary |
| Async iterable lifecycle is awkward to drive | Test `subscribeLifecycle` with a homemade iterable; assert only subscription options in the fake context |
| Coverage collapses early because half the modules are absent | Run thresholds at M7; do not weaken them |
| macOS or symlinked roots break containment | `tmp-root` realpaths its root; `parseOptions` realpaths the resolved root once; every expected path derives from them |
| Multiple plugin instances share memo or warn flags | All state is created inside `setup`, never at module scope |
| Live checks become a maintenance tax | Keep check 1; keep check 2 behind `npm run test:live` and allow the manual fallback |
