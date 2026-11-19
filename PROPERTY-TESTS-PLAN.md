# Property test plan

Companion to `TESTING.md`. `README.md` is the behavioral oracle. This document lists the pure functions where
generated inputs and shrinking would catch bugs the table-driven suites cannot, in priority order.

The organizing principle: a property test earns its place when there is an invariant that holds for a whole input
space, not just for the examples someone listed. Functions with small finite domains qualify because a generator
effectively verifies them exhaustively.

## Status

| Module | Functions | Status |
| --- | --- | --- |
| `src/fs-errors.ts` | `isMissing`, `isNotEmpty`, `isDestinationExists` | Done in `test/fs-errors.test.ts` |
| `src/layout.ts` | `isInside`, `sessionSegment`, `isSessionSegment`, `projectSlug`, `resolveLayout` | Done in `test/layout.test.ts` |
| `src/enforce.ts` | `evaluateEdit`, `evaluateExternal`, `applyPermission` | Next |
| `src/instructions.ts` | `rewriteInstructions` and the `replaceRoot` boundary logic | Planned |
| `src/sweep.ts` | `isStale`, `entryKind`, `childRole`, `decideEntry` | Planned |
| `src/logging.ts` | `warnOnce` | Planned |
| `src/index.ts` | `parseOptions`, `createSessionResolver` | Optional, higher effort |

## Tooling and conventions

- `fast-check` `^4.10.3` is a devDependency. It imports in ESM as `import fc from "fast-check";`.
- A property test is an ordinary `node:test` `test()` whose body calls `fc.assert(fc.property(arb, ...))`. The
  existing `test/**/*.test.ts` glob discovers it, so no npm script or devenv task needs to change.
- Keep the `TESTING.md` conventions: `when_{scenario}_then_it_{expected outcome}` names, a `subject` for the value
  under test, the three-paragraph setup/execution/assertions shape, and a suite header stating what is not covered.
- Default to `fc.assert`'s 100 runs. A failure already comes with a shrunk counterexample, so there is no need to
  inflate the run count.
- Generate path-like strings with `path.sep` and `path.join` rather than a hardcoded `/`; generated cases must behave
  on Windows as well as POSIX. The pre-existing known-hash case in `test/layout.test.ts` pins a POSIX spelling and is
  the exception.
- Verify every change with `devenv test` (typecheck, coverage-enforced unit tests, and git hooks).

## Done: `src/fs-errors.ts`

`isMissing`, `isNotEmpty`, and `isDestinationExists` are pure, total functions over `unknown`. The suite covers exact
membership for documented errno codes, rejection of malformed shapes, and two cross-predicate laws:

- `isMissing` is disjoint from both `isNotEmpty` and `isDestinationExists`.
- `isNotEmpty` implies `isDestinationExists`; `EISDIR` is the witness that makes the subset strict.

These predicates gate best-effort error handling in the sweep and lifecycle walkers, so a law check would catch an
accidental broadening that silently swallowed real filesystem errors.

## Done: `src/layout.ts`

Functions: `isInside`, `sessionSegment`, `isSessionSegment`, `projectSlug`, `resolveLayout`. The generated cases live
alongside the table-driven cases in `test/layout.test.ts`; their versions of the two "many sessions" tests replace the
fixed 24-item set.

Covered laws:

- `isInside` is irreflexive, antisymmetric, transitive along a generated descendant chain, holds for one appended safe
  segment, rejects siblings whose names share a textual prefix, and is invariant under `path.resolve` for literal
  absolute, relative, and traversal-shaped spellings, including mixed pairs.
- `sessionSegment` always returns a non-empty `ses`-prefixed value accepted by `isSessionSegment` with no path
  separator, for generated IDs spanning valid spellings, separators, `..`, empty input, unicode, and very long strings;
  valid IDs round-trip.
- `projectSlug` is well formed (7 lowercase base32 characters, readable part of at most 48 `[A-Za-z0-9_-]` characters,
  at most 56 UTF-8 bytes, no separator or `..` segment) and invariant under a spelling that resolves through
  `ignored/..`. Distinct inputs are deliberately not required to produce distinct slugs: CRC32 collisions and the
  48-character truncation make that law false. Calling a pure function twice was not kept as a separate property.
- `resolveLayout` composes its paths from the injected root (`root/<projectSlug>/<sessionSegment>`), keeps both
  directories strictly inside that root, and never puts one generated session directory inside another, both for an
  array of mixed sessions and for one session spread over many project directories.

These protect the core safety boundary: a prefix or traversal bug here would let one session write into another
without any other module noticing.

## Next: `src/enforce.ts`

Functions: `evaluateEdit`, `evaluateExternal`, `applyPermission`. The decision functions have algebraic laws that
a table of cases cannot establish generally.

- Compositionality: `evaluateEdit(resources)` returns a decision if and only if some singleton `evaluateEdit([r])`
  does. The same law holds for `evaluateExternal`.
- Monotonicity: adding resources cannot turn a block into no block. Enabling `allowExternal` can only add an allow,
  never remove one; with `false`, no external decision is produced.
- `mode` changes only `effect`, never whether a decision exists.
- Normalization invariance: classifying `[r]` and `[path.resolve(r)]` gives the same result.
- Own directory and all its descendants are always allowed. Any valid foreign session directory under the root is
  always blocked, and the message names both the caller's directory and the resolved resource.
- `applyPermission` writes only `effect` and `message` and is idempotent. For `edit`, `mode: "off"` leaves the
  evaluation untouched; `external_directory` is still allowed when `allowExternal` is true, so restrict the no-op law
  to `edit`.

Generators: arrays of resources drawn from a generated root, own directory, sibling directories with shared prefixes,
foreign session directories, paths outside the root, and relative or traversal-shaped spellings. Bias generation so
that valid `ses*` segments appear often; otherwise most cases fall into the "outside the root" branch.

## Planned: `src/instructions.ts`

Function: `rewriteInstructions`, including the boundary logic in the internal `replaceRoot`. This is the fiddliest
string code in the project, so shrinking has the most value here.

- Idempotence: a second call returns `false` and leaves the parts byte-identical. Equivalently,
  `rewrite(rewrite(parts))` equals `rewrite(parts)`.
- When the function returns `false`, the parts deep-equal their input. When it appends, exactly one fallback part is
  added and its text is a pure function of `sessionDir`.
- Boundary law: an occurrence of `defaultRoot` is replaced exactly when the preceding character is not in
  `leftContinuation` and the following text passes `isRightBoundary`. The two regexes are deliberately asymmetric:
  a dot blocks on the left, but on the right it blocks only when it starts a longer name. Generated surroundings
  should cover `opencode.`, `opencode.json`, `/tmp/opencode-other`, repeated occurrences, and a trailing separator.
- Non-text parts and `metadata.experimental.instructions` are never modified, even when the source part is rewritten.

Generators: arrays of text and non-text parts with arbitrary text, an optional `core/environment` metadata entry,
generated `defaultRoot` and `sessionDir` values, and `defaultRoot === ""` as a boundary case.

## Planned: `src/sweep.ts`

Functions: `isStale`, `entryKind`, `childRole`, `decideEntry`. Their domains are small and finite, so a generator acts
as exhaustive verification of the pure policy.

- `isStale` is symmetric in `atime` and `mtime` and monotone in the cutoff. An entry exactly at the cutoff is fresh.
- `entryKind` follows the priority directory, then symlink, then file, then other, when several `lstat` booleans are
  true, and is deterministic for every boolean combination.
- `childRole` returns `session` for a project child exactly when `isSessionSegment(name)` holds, `outside` otherwise,
  and always `nested` for a session child.
- `decideEntry` never sets both `traverse` and `remove`. `remove` implies a stale file or symlink in session or nested
  scope. `traverse` implies a directory outside `outside` scope. Both flags are monotone in `stale`.

A generated filesystem tree with a fixed `now` can then check the composed policy end to end: the sweep removes the
stale session and nested regular files and symlinks the policy selects and nothing else, then prunes directories that
become empty bottom-up, including fresh empty session and project directories. Keep that part separate from the pure
policy properties so real filesystem behavior stays in `sweep.test.ts`.

## Planned: `src/logging.ts`

Function: `warnOnce`. Generate sequences of warning kinds with `fc.array(fc.constantFrom(...warnKinds))` and assert
that each kind is logged at most once, exactly once if it occurs in the sequence, and in order of first appearance.
This protects the "warn once per plugin instance per kind" rule in `README.md` against a refactor of the dedup state.

## Optional: `src/index.ts`

`parseOptions` validates `ctx.options` once per setup. Generated `unknown` values can check that only the documented
types pass, that every rejection names the option and the bad value, and that `maxAgeHours` rejects `0`, negatives,
`NaN`, and `Infinity`. Valid `root` cases need a real temporary directory because the value is realpathed, so keep
those cases table-driven and generate only the invalid inputs. This also exercises `describeValue` with circular
objects, BigInt, and symbols.

`createSessionResolver` is a stateful candidate: concurrent resolves share one lookup, a rejected lookup is evicted,
and `forget` invalidates the entry. That needs state-machine style testing and is more effort than the pure-function
properties above, so it stays last.

## Not property-test territory

- The live checks in `test/live/`, the scripted provider, and the manual checklist are example-based by design.
- Hook registration, timer wiring, and the configured-deny precedence check are contract facts, not input spaces.
- The sweep timer is deliberately only tested for registration and cleanup, never by waiting 60 minutes.
