# opencode-session-temp

An OpenCode V2 plugin that gives every session, including every subagent, its own scratch directory under the OS
temp root, and stops file-writing tools from writing into another session's scratch files.

## Problem

The scratch directory OpenCode advertises to models is flat and shared. Every session and every parallel background
subagent writes there:

```
/tmp/opencode/
  gen_appendix.py       <- agent A
  gen_appendix.py       <- agent B, overwrote A's file
  output.json
```

Generic filenames collide. Last writer wins, and an agent can execute another agent's script or read output produced
by a different task. Nothing in the path names the session, so neither the model nor the user can tell the files
apart.

## Goal

- One scratch directory per session and per subagent, keyed by session ID and grouped under a project slug.
- A stable path for the lifetime of the session, so prompt caching is not invalidated by changing instructions. Moving
  a session is the one exception, handled below.
- Write enforcement for `write`, `edit`, and `patch`, so a session cannot overwrite another session's artifacts.
- Reads stay open, so a parent session can inspect files a subagent produced.
- No process-wide side effects: no global `TMPDIR` override, no changes outside the scratch root.
- The scratch root cleans itself up, so old session directories do not accumulate.

Non-goals: security isolation (same OS user, same filesystem permissions), enforcing shell redirections, and
coordinating handoffs between sessions beyond "read the other directory by path".

## Behavior

### Layout

The default root is `path.join(os.tmpdir(), "opencode")`, i.e. `/tmp/opencode` on Linux.

```
<tmpdir>/opencode/                 0700, created on demand
  <project-slug>/                  0700, e.g. Some-project-app-1a2b3c4d
    <sessionID>/                   0700, the session's writable scratch dir
```

`<project-slug>` is the session's location directory relative to `os.homedir()`, or relative to `/` when it is outside
the home directory, with path separators and unsafe characters replaced by `-`, plus `-` and the first 8 hex
characters of `sha256(projectID)`. The hash keeps distinct projects from sharing a slug when normalization is lossy.

The plugin reads the session's own location and project with `ctx.session.get`, memoized per session, instead of
`ctx.location`, which describes the plugin instance and not necessarily the session.

There is no separate `global` bucket. In V2 every session has a `projectID` and a location, including sessions opened
in a directory that is not a Git repository. A session opened directly in the home directory or at `/` gets the slug
`home-<hash>` or `root-<hash>`. If a server ever reports a session without a usable location, the plugin falls back to
`global/<sessionID>`.

`<sessionID>` is used verbatim, so it matches `OPENCODE_SESSION_ID` in shell subprocesses and scripts can reconstruct the
path. The ID is validated as a single safe path segment (`^[A-Za-z0-9._-]+$` and a `ses` prefix); if one ever fails,
the plugin uses a sanitized form plus `-` and the first 8 hex characters of `sha256(original)` instead.

### Model instructions

`ctx.session.hook("context", ...)` runs for the agent loop, including subagent requests.

1. Resolve the session's scratch directory from its own `location.directory` and `projectID`, obtained with
   `ctx.session.get({ sessionID })` and memoized per session.
2. Create the directory with `mkdir` recursive and mode `0700`. Cache the result per session in memory.
3. Locate the system part whose `metadata.experimental.instructions` contains the `core/environment` source.
4. Rewrite that part's text: take the source text, replace the default scratch path (`<tmpdir>/opencode`) with the
   session directory, and substitute the result back into the part. The model then sees one instruction that points
   at its own directory, and core's generic hint does not contradict it.
5. If the source or the replacement is not found, append a new text part with the session directory and log a warning
   once per process. The appended text is identical on every call, so the cache stays valid.

The rewrite is idempotent: if the part already contains the session directory, return without changing anything.

If the directory cannot be created, log once and leave the instructions untouched. Enforcement is disabled for that
session rather than denying writes into a directory that does not exist.

### Enforcement

`ctx.permission.hook("evaluate", ...)` reviews decisions after configured rules run.

- `edit` (covers `write`, `edit`, and `patch`): resolve each resource. Paths outside the scratch root are left alone.
  Paths inside the root but inside the session's own directory are left alone. Paths inside another session's
  directory get the configured effect and a message naming the session's own directory.
- `read` and every other action: untouched. Cross-session reads are allowed by design.
- `external_directory`: when the resource is inside the scratch root, set `effect = "allow"`, so the per-session
  directory does not trigger prompts under an `external_directory: "*" ask` policy.

The `enforce` option selects the effect for writes outside the session directory:

- `"deny"` (default): block the write. The model sees the denial reason and can retry in its own directory.
- `"ask"`: escalate to the normal permission prompt. Useful while adopting the plugin or when cross-session writes
  are occasionally legitimate.
- `"off"`: do not evaluate `edit` at all. This is outcome-equivalent to `"allow"` for these writes, except that the
  hook is skipped instead of adding an allow rule, so no denial message is produced. Instructions and the
  `external_directory` allowance still apply, but sessions can overwrite each other's scratch files again.

A configured `deny` never reaches the hook, so an operator's explicit block still wins.

Enforcement only affects tools that call the permission system. Shell commands are covered in the next section.

### Shell commands

The plugin does not intercept shell. `ctx.shell.hook("create.before", ...)` has no `sessionID`, and setting `TMPDIR`
there is process-wide, which would make every session share one directory again. Core injects
`OPENCODE_SESSION_ID` into shell subprocesses after that hook runs, so the plugin cannot read it there either.

Shell redirections and `mktemp` are therefore advisory. The instruction gives the model a stable literal path, and
`OPENCODE_SESSION_ID` matches the last segment of that path, so a script can reconstruct it if the literal is lost.
Not setting `TMPDIR` is deliberate: a misleading global value would be worse than no value.

### Cleanup

On setup and then every 60 minutes:

- Walk the immediate children of the scratch root as project directories. Skip symlinked project directories.
- Within each project directory, consider only names matching `^ses[A-Za-z0-9._-]+$`, so other tools and plugins that
  share the root are untouched.
- Delete regular files and symlinks whose access time and modification time are both older than `maxAgeHours`.
- Never follow symlink targets, never touch loose files directly under the root, and never remove the root itself.
- Remove session directories once they are empty, then project directories once they are empty.

The timer is `unref`'d and cleared by the cleanup function returned from `setup`. If a sweep fails, log the error and
continue; cleanup is best effort.

### Session lifecycle

`setup` subscribes to `session.deleted`, `session.archived`, and `session.moved` through `ctx.event.subscribe`, with an
`AbortController` that the cleanup function aborts. Handlers are idempotent: several plugin instances may receive the
same event, and a directory may already be gone.

Directories are located by scanning `<root>/<project-dir>/<sessionID>`, because an event does not always name the
project directory that existed before a move.

- `session.deleted`: remove every matching directory. IDs are never reused, so a repeated event is harmless, and a
  missing directory is ignored. Disable with `cleanupOnDelete` if child sessions are removed automatically while a
  parent still needs a subagent's artifacts.
- `session.archived`: keep directories by default. Archiving is reversible (`session.unarchived`), so deleting here
  would lose the files of a session that is resumed later. Opt in with `cleanupOnArchive`.
- `session.moved`: compute the new directory from the event's `location` and `projectID`, find the old one by scan,
  and rename it after creating the new project directory. If the destination already exists, move the remaining
  entries individually, skip names that clash, and leave the old directory for the sweep. Ignore `ENOENT` from
  concurrent handlers. The instruction text changes to the new path on the next model call, which invalidates the
  prompt cache once.

If the rename fails, log it, let the next model call create an empty directory at the new path, and leave the old
directory to the sweep. Files from before the move are then unavailable at the new path.

The subscription only lives while the server runs. Events missed during downtime are covered by the sweep.

### Configuration

Plugin options are read from `ctx.options`:

| Option             | Default                              | Meaning                            |
| ------------------ | ------------------------------------ | ---------------------------------- |
| `root`             | `path.join(os.tmpdir(), "opencode")` | Scratch root, absolute.            |
| `enforce`          | `"deny"`                             | `"deny"`, `"ask"`, or `"off"`.     |
| `allowExternal`    | `true`                               | Allow external checks inside root. |
| `sweep`            | `true`                               | Cleanup at setup and hourly.       |
| `maxAgeHours`      | `48`                                 | Age threshold for unused files.    |
| `cleanupOnDelete`  | `true`                               | Remove dir when session deleted.   |
| `cleanupOnArchive` | `false`                              | Remove dir when session archived.  |

## Install

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode/plugins/opencode-session-temp",
      "options": { "enforce": "deny" },
    },
  ],
}
```

The V2 server part imports `Plugin` from `@opencode/plugin`, not the V1 `@opencode-ai/plugin` package. The package
entry may be any absolute directory; the conventional location for local plugins is `~/.config/opencode/plugins/`.

The plugin auto-allows `external_directory` checks inside the root. The equivalent explicit rule is optional and
documents intent:

```jsonc
{
  "permissions": [{ "action": "external_directory", "resource": "/tmp/opencode/*", "effect": "allow" }],
}
```

Config changes reload plugins without a restart.

## Relationship to existing options

- **Plain permission rules** such as `edit` deny on `/tmp/opencode/*` plus allow on `/tmp/opencode/*/*` block
  top-level files and allow one level of subdirectory, but two sessions can still pick the same subdirectory, and
  shell is unaffected. This plugin makes the directory a function of the session, so two sessions cannot converge on
  the same path.
- **`opencode-temp-sanitize`** scopes the directory by project and sets a project-wide `TMPDIR`. It solves tmpfs
  growth and cross-project clutter; concurrent sessions in the same project still collide. This plugin scopes by
  session and enforces writes.
- **Prompt-only guidance** (`AGENTS.md`, or `mktemp -d`) is advisory. Models drift.

## Development

`devenv` manages the environment; `node` is not installed yet. Planned modules:

```
src/index.ts          Plugin.define, wiring, cleanup registration
src/layout.ts         root, project slug, session directory
src/instructions.ts   context hook rewrite
src/enforce.ts        permission hook
src/sweep.ts          age-based cleanup and lifecycle handlers
```

Tests use `node:test`, one setup/execution/assertions paragraph per test, `subject` for the value under test, and
`test_when_{scenario}_then_it_{expected outcome}` names.
