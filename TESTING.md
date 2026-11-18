# Testing plan

`README.md` is the specification. There is no reference implementation, so the README is the oracle. Every behavior
bullet should map to at least one test, and every test name should say which behavior it protects.

"Correct" means three separate things, checked at three levels:

1. The pure logic is right: paths, rewriting, decisions, and sweeping behave as specified.
2. The plugin honors the OpenCode V2 contract: the right hooks are registered, with the right event shapes.
3. OpenCode actually changes behavior: two sessions get separate directories, and a cross-session write is denied.

Unit tests cover the first. A fake context and the TypeScript compiler cover the second. A small number of live checks
cover the third. Do not use a real language model in any automated test.

## Test layout

```text
test/
  helpers/
    fake-context.ts    records hooks, events, and session lookups
    tmp-root.ts        unique root, realpath, cleanup
  layout.test.ts
  instructions.test.ts
  enforce.test.ts
  sweep.test.ts
  lifecycle.test.ts
  plugin.test.ts
  live/                opt-in; `*.live.ts`, not in the default run
    helpers/live-server.ts    isolated HOME, real server, scripted provider
    fixtures/probe-plugin/    records the system parts after the rewrite
    instructions.live.ts
    write.live.ts
```

`test/live/` is excluded from the default run because it needs a real server. Name live files `*.live.ts` so the
default glob skips them, keep them runnable with `devenv tasks run test:live` (or `npm run test:live`), and run them
before a release. They need `opencode` (the pinned 2.2.6 server) on `PATH`; `OPENCODE_BIN` overrides the binary. Each
check starts an isolated `HOME` and its own ports, so it does not touch the user's config, sessions, or scratch root.
The npm scripts mirror the devenv tasks; `devenv test` remains the full verification pass.

## Testability rules for `src/`

The test plan depends on these design choices. Make them before writing tests.

- `layout.ts` is pure: `resolveLayout(root, session)` returns the slug and directory. It does not read
  `os.tmpdir()` or the environment at module scope.
- `instructions.ts` separates the pure rewrite from the hook. The pure function receives the system parts, the
  default root, and the session directory, and returns whether it changed anything.
- `enforce.ts` exports a pure decision function. The hook adapter only reads the event, calls the function, and writes
  back `effect` and `message`.
- `sweep.ts` exports `sweepOnce(root, options, now)` and the age predicate. Timers live in `index.ts`.
- `lifecycle.ts` exports `subscribeLifecycle(events, deps)` and keeps the handlers behind it, so tests drive a
  homemade async iterable without a transport.
- `logging.ts` owns the injected `Logger` and warn-once state. `fs-errors.ts` owns the race predicates shared by
  the sweep and lifecycle walkers.
- `index.ts` owns per-instance state: the memoized session map, warn-once flags, the timer, and the abort controller.
  Do not put this state at module scope, or tests leak and multiple plugin instances share it.
- Inject `root`, `now`, and `logger`. Inject `rename` only for failure tests. Do not abstract the filesystem
  beyond that.
- Keep hook adapters thin enough that the fake context can invoke them exactly as core does, with a mutable event.

## Layer 1: logic tests

Use real temporary directories for anything that touches the filesystem. Do not use `mock-fs`. Symlinks, modes,
`utimes`, and `ENOTEMPTY` are part of the behavior.

`test/helpers/tmp-root.ts` should create a unique root with `fs.mkdtemp` under `os.tmpdir()`, call `fs.realpath`, and
register cleanup with `t.after`. Never let a test write into the production default `/tmp/opencode`. The realpath
matters: on macOS `/tmp` is a symlink to `/private/tmp`, and the plugin must compare resolved paths.

### `layout.test.ts`

| Case | Assertion |
| --- | --- |
| Typical project | Readable part is the last two segments, stripped, joined with `_`, plus the hash |
| Shared last two segments | `/a/b/c` and `/x/b/c` produce `b_c` with different hashes |
| Filesystem root | Slug is `root-<hash>` |
| Home directory | Slug is `home_<user>-<hash>`; home has no special case |
| Stripped characters | `.`, `_`, and whitespace are removed from each segment before assembly |
| Unsafe characters | Replaced with `-`, runs collapsed, never producing a path separator or `..` |
| Lossy normalization | Two paths that strip to the same readable part get different hashes |
| Empty readable | `project-<hash>` |
| Hash encoding | A known directory and project ID produce the documented 7-character lowercase base32 suffix |
| Long segment | Readable part is the last 48 characters; the slug is at most 56 bytes |
| Valid session ID | Used verbatim, including the `ses` prefix |
| Invalid session ID | Sanitized plus hash; slash, `..`, and empty input are rejected |
| Determinism | The same session and project produce the same path across calls |

Add property tests for two invariants: a generated session directory is always a strict descendant of its project
directory, and no session's directory is inside another session's directory. These catch prefix and traversal bugs that
table tests miss.

### `instructions.test.ts`

| Case | Assertion |
| --- | --- |
| Part selection | The rewrite targets the part whose `metadata.experimental.instructions` names `core/environment` |
| Path replacement | Only the exact default root is replaced |
| Prefix collision | `/tmp/opencode` does not corrupt `/tmp/opencode-other` |
| Idempotence | A second call changes nothing and returns `false` |
| Stability | Two consecutive calls produce byte-identical text for the same session |
| Source missing | A stable text part is appended and a warning is logged once |
| Replacement missing | The fallback is used, not a silent no-op |
| Directory creation failure | Instructions stay untouched and enforcement is disabled |
| Non-text parts | Untouched |
| Metadata | `metadata.experimental.instructions` is not rewritten; it is a copy |

The fixture should be a minimal `core/environment` part, not core's full prose. Its
`metadata.experimental.instructions` is an array of `{ key, text }` entries, matching core 2.2.6, which concatenates
several instruction sources into one part. Pin it once, and let the live check detect upstream drift.

### `enforce.test.ts`

Use a table over action, resource location, mode, and `allowExternal`.

| Case | Assertion |
| --- | --- |
| Own directory | Unchanged, including nested subdirectories |
| Sibling with a shared prefix | `sesA` versus `sesAB` is treated as foreign |
| Another session's directory | Configured effect and a message naming the caller's own directory |
| Outside the root | Unchanged |
| Loose file directly under the root | Decide and pin the behavior; the current README only names other session directories |
| `enforce: "deny"` | `effect = "deny"` |
| `enforce: "ask"` | `effect = "ask"` |
| `enforce: "off"` | The `edit` hook is not registered; `external_directory` still is |
| `read` and other actions | Unchanged |
| `external_directory` inside root | `allow` only when `allowExternal` is true |
| `external_directory` outside root | Unchanged |
| Multiple resources | Each is evaluated; one foreign resource is enough to block |
| `..`, relative, and nonexistent paths | Normalized and classified safely |
| Message content | Names the caller's directory and is actionable |
| Configured deny | Not reachable through the hook; verify only in the live check |

Containment must be segment-aware. `path.relative` plus a check for `..` or an absolute result is the safe idiom.

### `sweep.test.ts`

Use a fixed `now`, `fs.utimes`, and a real tree.

| Case | Assertion |
| --- | --- |
| Stale file | Deleted |
| Fresh mtime, stale atime | Kept |
| Stale mtime, fresh atime | Kept |
| Exactly at the cutoff | Pin the boundary behavior |
| Symlinked project directory | Skipped |
| Non-`ses*` directory | Untouched |
| Loose file under the root | Untouched |
| Stale symlink | Link removed, target untouched |
| FIFO or socket | Left alone |
| Empty subdirectories | Pruned bottom-up |
| Sweep root | Never removed |
| Missing directory | No error |
| Entry removed mid-scan | No error |
| One project fails | Other projects still sweep |
| Concurrent sweeps | Idempotent and race-safe |

For races, spy on `fs.promises.lstat` or `fs.promises.rename` to remove the target between scan and action. Do not wait
for the hourly timer. Test `sweepOnce` directly, and test the timer only for registration and cleanup.

### `lifecycle.test.ts`

| Case | Assertion |
| --- | --- |
| `session.deleted` | Every matching directory across project directories is removed |
| Duplicate delete event | Idempotent, missing directory ignored |
| Delete disabled | `cleanupOnDelete: false` keeps the directory |
| `session.archived` | Kept by default, removed when `cleanupOnArchive` is true |
| `session.moved` | Directory is renamed and the memoized path is invalidated |
| Move destination exists | Non-clashing entries move, clashes are skipped, old directory remains |
| Move race | `ENOENT` from a concurrent handler is ignored |
| Move failure | Logged, no throw, old directory left to the sweep |
| Cleanup | Event subscription is aborted and the timer is cleared |

The move test is the important one. A memo that survives a move leaves the model pointed at the old path.

## Layer 2: contract and wiring tests

### Type check

`tsc --noEmit` against the pinned `@opencode/plugin`. Export the plugin with `Plugin.define` and let the compiler check
the default export. This catches hook renames, event shape changes, and missing domain methods.

### Fake context

`test/helpers/fake-context.ts` implements only the surface the plugin uses: `location`, `options`, `session.get`,
`session.hook`, `permission.hook`, and `event.subscribe`. It records every registration and exposes helpers to fire a
hook or push an event. Type the shape against `Plugin.Context` and keep the single unavoidable cast at the boundary,
inside the helper, so no test uses `as any`.

`test/plugin.test.ts` checks wiring, not logic:

| Case | Assertion |
| --- | --- |
| Setup | Registers `session.context`, `permission.evaluate`, and the event subscription |
| Options | Defaults apply, explicit values override, invalid values are handled or rejected |
| `enforce: "off"` | No `edit` evaluation, but `external_directory` is still registered |
| `allowExternal: false` | `external_directory` is not modified |
| Cleanup | Every registration is disposed, the subscription is aborted, the timer is cleared |
| Memoization | `session.get` is called once per session |
| Move | The memo is invalidated and the next lookup uses the new location |
| Concurrency | Two sessions resolving at once get distinct directories |
| No shell hook | The plugin does not register `shell.create.before` and does not set `TMPDIR` |

That last test is a regression guard for the design decision in the README.

## Layer 3: live checks

These are opt-in and not matched by the default test glob. Run them with `devenv tasks run test:live` (or
`npm run test:live`) before a release and after an OpenCode upgrade.

Checks 1 and 2 are implemented in `test/live/`. Check 3 stays on the manual checklist: proving that a configured
`deny` never reaches the hook needs a permission-hook probe in addition to the scripted provider.

1. **Instruction visibility.** Load a second probe plugin after this one. Its `context` hook sees the system parts
   after the first plugin rewrote them. Persist the parts and assert the session directory is present. Also assert the
   text is byte-identical on the next call, and changes only after a move. This needs no language model.
2. **Two-session write.** Register a local OpenAI-compatible stub that returns a `write` tool call. Drive two
   sessions through the API with the same filename. Assert separate paths, a denied cross-write with the configured
   message, and a successful cross-session read.
3. **Configured deny precedence.** Set an explicit `edit` deny in configuration and assert the hook is not invoked.
   This is the only way to test the documented "configured deny never reaches the hook" rule.

If the scripted provider is too costly to maintain, keep check 1 and make check 2 a manual checklist item. Do not
replace it with a real model.

### Manual checklist

- Install the plugin by absolute path, set `root` to a temporary root, and open two sessions in the same project.
- Ask each session to write the same generic filename; confirm distinct directories.
- Attempt a write into the other session's directory; confirm the denial message names the caller's directory.
- Read the other session's file; confirm it is allowed.
- Confirm `OPENCODE_SESSION_ID` equals the final path segment in a shell command.
- Confirm shell redirection still bypasses enforcement. This is documented and expected.
- Set `external_directory: "*": "ask"` and confirm no prompt appears inside the root.
- Set `enforce: "ask"` and confirm the normal permission prompt appears for a cross-session write.
- Move a session and confirm the directory is renamed and the instruction changes on the next call.
- Delete a session and confirm the directory is removed.
- Check logs for repeated warnings.

## Test conventions

Every test is three paragraphs: setup, execution, assertions. Assign the value under test to `subject`. Name tests
`when_{scenario}_then_it_{expected outcome}`.

```ts
test("when_resource_is_a_sibling_with_a_shared_prefix_then_it_is_treated_as_foreign", () => {
  // Setup: two session directories whose names share a prefix.
  const layout = resolveLayout(root, session("ses_A"));
  const resource = path.join(root, layout.projectDir, "ses_AB", "notes.txt");

  // Execution: classify a write from the shorter-named session.
  const subject = evaluateEdit({ root, ownDir: layout.sessionDir, resources: [resource], mode: "deny" });

  // Assertions: the shared prefix must not make the sibling look local.
  assert.equal(subject.effect, "deny");
  assert.match(subject.message ?? "", /ses_A/);
});
```

Add a suite header stating what the file covers and what it deliberately does not cover. This is the most useful
comment in a test file.

## Reference: `opencode-temp-sanitize`

The sibling plugin at <https://github.com/GFN-CIS/opencode-temp-sanitize> is the closest prior art. It has three Vitest
suites, about 25 tests, real filesystem fixtures, a fake context, 80% coverage thresholds, Biome, knip, and CI on Node
22 and 24. It has no test that loads the plugin into a real OpenCode server.

Useful mapping:

| `opencode-temp-sanitize` | This plugin |
| --- | --- |
| `project-tmp.test.js`: pure slug and hint rewrite | `layout.test.ts` and `instructions.test.ts` |
| `sweep.test.js`: real tree, fixed `now`, races | `sweep.test.ts` |
| `plugin.test.js`: fake context, mutable hook events | `plugin.test.ts`, plus permission and lifecycle tests |
| No analogue | `enforce.test.ts`, `session.deleted`, `session.archived`, `session.moved` |

Copy these habits:

- Three suites by concern: pure logic, filesystem effects, wiring.
- A suite header that states what is covered and what is not.
- Real temp directories, a fixed clock, `utimes`, and targeted spies for races.
- A fake context that records callbacks and invokes them the way core does.
- A pinned upstream fixture and an explicit test for the miss branch.
- Table tests for name classification and decision matrices.
- Explicit cleanup in `afterEach`, and no waiting for timers.
- Coverage thresholds and a dead-code check.

Do not copy these:

- Mutating `process.env.TMPDIR` and `HOME`. Inject `root`, `now`, and `logger`; environment mutation is fragile under
  the `node:test` concurrency model.
- Plain JavaScript without a type check. Use TypeScript and `tsc --noEmit`.
- Reading `readdirSync(root)[0]` to find the directory. Compute the expected path from the pure function.
- Failing setup when the shared root is missing. This plugin creates the root on demand and disables enforcement if it
  cannot.
- Their lack of a live check. Their fake context mirrors core's dispatch; if core changes hook invocation, their tests
  stay green. This plugin's permission enforcement fails silently in that case, so keep at least the probe-plugin
  check.

The biggest architectural difference is scope. Their plugin is project-scoped, so one instance serves one directory.
This plugin is session-scoped, so one instance serves many sessions and subagents. Memoization, move invalidation, and
concurrent sessions are testable state here and have no analogue there.

## Coverage

Target 80% for lines, functions, and branches in `src/`. Run `devenv tasks run test:coverage` (or
`npm run test:coverage`); the thresholds are defined in both `devenv.nix` and `package.json`.

Do not chase 100%. The untested remainder should be defensive logging and timer wiring, and that should be visible in
the suite headers.

## What not to do

- Do not call a real model in CI. Use a scripted provider or a probe plugin.
- Do not mock the filesystem. Real temp directories catch symlink, mode, and timestamp behavior.
- Do not wait for the 60-minute sweep. Test `sweepOnce` with an injected clock.
- Do not snapshot core's full instruction prose. Use a minimal fixture and one live compatibility check.
- Do not assert that a configured `deny` reaches the hook. Core does not call the hook in that case.
- Do not let tests write to the production default root.

## Pinned decisions

- A loose file directly under the scratch root or a project directory is left alone.
- A symlink inside the own directory is classified lexically, without resolving its target.
- A file is stale only when both `atime` and `mtime` are strictly older than the cutoff; no touch-on-use.
- Invalid options reject `setup` with the option name and the bad value; no silent fallback.

Project slug length is pinned: the readable part keeps the last 48 characters, and the slug is at most 56 bytes.
Covered by the `Long segment` and `Filesystem root` cases.

## First tests to write

1. `when_resource_is_a_sibling_with_a_shared_prefix_then_it_is_treated_as_foreign`
2. `when_default_path_is_a_prefix_of_another_path_then_only_the_exact_path_is_rewritten`
3. `when_context_hook_runs_twice_then_the_system_text_is_byte_identical`
4. `when_project_ids_differ_then_slugs_differ`
5. `when_atime_is_fresh_and_mtime_is_stale_then_the_file_is_kept`
6. `when_two_sessions_share_a_filename_then_paths_differ_and_cross_write_is_denied`
