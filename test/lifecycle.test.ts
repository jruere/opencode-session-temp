/**
 * Covers session lifecycle handling from README "Session lifecycle": delete and archive cleanup, moves with
 * rename/merge semantics, per-session state invalidation, warning deduplication, symlinked project skipping, and
 * the subscription loop's abort and failure behavior.
 *
 * Does not cover hook or subscription registration, the sweep timer, or option parsing (M6). Events are driven
 * through a homemade async iterable, so no transport or fake context is needed. Every filesystem test uses a
 * fresh real temporary root.
 */
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import {
	lstat,
	mkdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { format } from "node:util";
import { resolveLayout } from "../src/layout.ts";
import {
	type LifecycleDeps,
	type LifecycleEvent,
	subscribeLifecycle,
} from "../src/lifecycle.ts";
import type { Logger } from "../src/logging.ts";
import { makeSessionDir, makeTmpRoot } from "./helpers/tmp-root.ts";

interface Harness {
	readonly deps: LifecycleDeps;
	readonly warnings: string[];
	readonly errors: string[];
	readonly forgotten: string[];
}

function makeHarness(
	root: string,
	options: {
		cleanupOnDelete?: boolean;
		cleanupOnArchive?: boolean;
	} = {},
): Harness {
	const warnings: string[] = [];
	const errors: string[] = [];
	const forgotten: string[] = [];
	const logger: Logger = {
		warn: (message, ...args) => warnings.push(format(message, ...args)),
		error: (message, ...args) => errors.push(format(message, ...args)),
	};
	const deps: LifecycleDeps = {
		root,
		cleanupOnDelete: options.cleanupOnDelete ?? true,
		cleanupOnArchive: options.cleanupOnArchive ?? false,
		logger,
		warnState: { warned: new Set() },
		forgetSession: (sessionID) => {
			forgotten.push(sessionID);
		},
	};
	return { deps, warnings, errors, forgotten };
}

function deletedEvent(sessionID: string): LifecycleEvent {
	return { type: "session.deleted", data: { sessionID } };
}

function archivedEvent(sessionID: string): LifecycleEvent {
	return { type: "session.archived", data: { sessionID } };
}

function movedEvent(
	sessionID: string,
	location: string,
	projectID: string,
): LifecycleEvent {
	return {
		type: "session.moved",
		data: { sessionID, projectID, location: { directory: location } },
	};
}

async function drive(
	deps: LifecycleDeps,
	...events: LifecycleEvent[]
): Promise<void> {
	await subscribeLifecycle(streamOf(events), deps);
}

async function* streamOf(
	events: LifecycleEvent[],
): AsyncIterable<LifecycleEvent> {
	yield* events;
}

async function exists(target: string): Promise<boolean> {
	try {
		await lstat(target);
		return true;
	} catch {
		return false;
	}
}

test("when_a_session_is_deleted_then_every_matching_directory_is_removed", async (t) => {
	// Setup: the same session ID under two project directories beside an unrelated session.
	const root = await makeTmpRoot(t);
	const first = await makeSessionDir(root, "example_project", "ses_A");
	const second = await makeSessionDir(root, "other_project", "ses_A");
	const survivor = await makeSessionDir(root, "example_project", "ses_B");
	const harness = makeHarness(root);

	// Execution: drive one delete event through the subscription loop.
	await drive(harness.deps, deletedEvent("ses_A"));

	// Assertions: both matches are gone, the sibling survives, and the session state is forgotten.
	assert.equal(await exists(first), false);
	assert.equal(await exists(second), false);
	assert.equal(await exists(survivor), true);
	assert.deepEqual(harness.forgotten, ["ses_A"]);
	assert.deepEqual(harness.warnings, []);
	assert.deepEqual(harness.errors, []);
});

test("when_a_delete_event_is_repeated_then_it_is_idempotent", async (t) => {
	// Setup: one session directory and the same delete event twice.
	const root = await makeTmpRoot(t);
	const sessionDir = await makeSessionDir(root, "example_project", "ses_A");
	const harness = makeHarness(root);

	// Execution: drive both events without recreating the directory.
	await drive(harness.deps, deletedEvent("ses_A"), deletedEvent("ses_A"));

	// Assertions: the second removal tolerates the missing directory and logs nothing.
	assert.equal(await exists(sessionDir), false);
	assert.deepEqual(harness.forgotten, ["ses_A", "ses_A"]);
	assert.deepEqual(harness.warnings, []);
	assert.deepEqual(harness.errors, []);
});

test("when_cleanup_on_delete_is_disabled_then_the_directory_is_kept", async (t) => {
	// Setup: delete cleanup disabled for a session directory that exists.
	const root = await makeTmpRoot(t);
	const sessionDir = await makeSessionDir(root, "example_project", "ses_A");
	const harness = makeHarness(root, { cleanupOnDelete: false });

	// Execution: drive one delete event.
	await drive(harness.deps, deletedEvent("ses_A"));

	// Assertions: the artifacts stay for a parent, while stale session state is still cleared.
	assert.equal(await exists(sessionDir), true);
	assert.deepEqual(harness.forgotten, ["ses_A"]);
	assert.deepEqual(harness.errors, []);
});

test("when_a_session_is_archived_then_its_directory_is_kept_by_default", async (t) => {
	// Setup: archive cleanup left at its default.
	const root = await makeTmpRoot(t);
	const sessionDir = await makeSessionDir(root, "example_project", "ses_A");
	const harness = makeHarness(root);

	// Execution: drive one archive event.
	await drive(harness.deps, archivedEvent("ses_A"));

	// Assertions: archiving is reversible, so nothing is removed and no state is cleared.
	assert.equal(await exists(sessionDir), true);
	assert.deepEqual(harness.forgotten, []);
	assert.deepEqual(harness.warnings, []);
	assert.deepEqual(harness.errors, []);
});

test("when_cleanup_on_archive_is_enabled_then_the_directory_is_removed", async (t) => {
	// Setup: archive cleanup opted in for an existing session directory.
	const root = await makeTmpRoot(t);
	const sessionDir = await makeSessionDir(root, "example_project", "ses_A");
	const harness = makeHarness(root, { cleanupOnArchive: true });

	// Execution: drive one archive event.
	await drive(harness.deps, archivedEvent("ses_A"));

	// Assertions: the directory goes and the session state is invalidated.
	assert.equal(await exists(sessionDir), false);
	assert.deepEqual(harness.forgotten, ["ses_A"]);
	assert.deepEqual(harness.warnings, []);
	assert.deepEqual(harness.errors, []);
});

test("when_a_session_moves_then_its_directory_is_renamed_to_the_new_layout", async (t) => {
	// Setup: a session with a file under its old project location.
	const root = await makeTmpRoot(t);
	const sessionID = "ses_A";
	const projectID = "prj_move";
	const oldLayout = resolveLayout(root, {
		sessionID,
		projectID,
		location: { directory: path.join(root, "workspace", "old-name") },
	});
	const newLayout = resolveLayout(root, {
		sessionID,
		projectID,
		location: { directory: path.join(root, "workspace", "new-name") },
	});
	await mkdir(oldLayout.sessionDir, { recursive: true });
	await writeFile(path.join(oldLayout.sessionDir, "notes.txt"), "kept");
	const harness = makeHarness(root);

	// Execution: drive a move event carrying the new location and project.
	await drive(
		harness.deps,
		movedEvent(sessionID, path.join(root, "workspace", "new-name"), projectID),
	);

	// Assertions: the old path is gone, the new path holds the files, and the memo is invalidated.
	assert.equal(await exists(oldLayout.sessionDir), false);
	assert.equal(
		await readFile(path.join(newLayout.sessionDir, "notes.txt"), "utf8"),
		"kept",
	);
	assert.deepEqual(harness.forgotten, [sessionID]);
	assert.deepEqual(harness.warnings, []);
	assert.deepEqual(harness.errors, []);
});

test("when_the_move_destination_exists_then_non_clashing_entries_move_and_clashes_are_skipped", async (t) => {
	// Setup: old and new session directories that both contain `b.txt`.
	const root = await makeTmpRoot(t);
	const sessionID = "ses_A";
	const projectID = "prj_merge";
	const oldLayout = resolveLayout(root, {
		sessionID,
		projectID,
		location: { directory: path.join(root, "workspace", "old-name") },
	});
	const newLayout = resolveLayout(root, {
		sessionID,
		projectID,
		location: { directory: path.join(root, "workspace", "new-name") },
	});
	await mkdir(oldLayout.sessionDir, { recursive: true });
	await writeFile(path.join(oldLayout.sessionDir, "a.txt"), "old a");
	await writeFile(path.join(oldLayout.sessionDir, "b.txt"), "old b");
	await mkdir(newLayout.sessionDir, { recursive: true });
	await writeFile(path.join(newLayout.sessionDir, "b.txt"), "new b");
	const harness = makeHarness(root);

	// Execution: drive the move into the occupied destination.
	await drive(
		harness.deps,
		movedEvent(sessionID, path.join(root, "workspace", "new-name"), projectID),
	);

	// Assertions: only the missing name moves, the clash keeps the destination copy, and the old dir remains.
	assert.equal(
		await readFile(path.join(newLayout.sessionDir, "a.txt"), "utf8"),
		"old a",
	);
	assert.equal(
		await readFile(path.join(newLayout.sessionDir, "b.txt"), "utf8"),
		"new b",
	);
	assert.equal(await exists(oldLayout.sessionDir), true);
	assert.equal(
		await readFile(path.join(oldLayout.sessionDir, "b.txt"), "utf8"),
		"old b",
	);
	assert.deepEqual(harness.forgotten, [sessionID]);
	assert.deepEqual(harness.errors, []);
});

test("when_the_move_resolves_to_the_same_directory_then_nothing_is_renamed", async (t) => {
	// Setup: a move event whose location and project match the existing layout.
	const root = await makeTmpRoot(t);
	const sessionID = "ses_A";
	const projectID = "prj_same";
	const location = path.join(root, "workspace", "same-name");
	const layout = resolveLayout(root, {
		sessionID,
		projectID,
		location: { directory: location },
	});
	await mkdir(layout.sessionDir, { recursive: true });
	await writeFile(path.join(layout.sessionDir, "notes.txt"), "kept");
	const harness = makeHarness(root);
	const originalRename = fsp.rename;
	let renameCalls = 0;
	fsp.rename = (async (from: string, to: string) => {
		renameCalls++;
		return originalRename(from, to);
	}) as unknown as typeof fsp.rename;
	t.after(() => {
		fsp.rename = originalRename;
	});

	// Execution: drive the no-op move.
	await drive(harness.deps, movedEvent(sessionID, location, projectID));

	// Assertions: the directory stays in place, no rename runs, and state is still forgotten.
	assert.equal(renameCalls, 0);
	assert.equal(
		await readFile(path.join(layout.sessionDir, "notes.txt"), "utf8"),
		"kept",
	);
	assert.deepEqual(harness.forgotten, [sessionID]);
	assert.deepEqual(harness.errors, []);
});

test("when_the_old_directory_disappears_before_the_rename_then_the_race_is_ignored", async (t) => {
	// Setup: a rename that loses the race and reports the old directory as gone.
	const root = await makeTmpRoot(t);
	const sessionID = "ses_A";
	const projectID = "prj_race";
	const oldLayout = resolveLayout(root, {
		sessionID,
		projectID,
		location: { directory: path.join(root, "workspace", "old-name") },
	});
	const newLayout = resolveLayout(root, {
		sessionID,
		projectID,
		location: { directory: path.join(root, "workspace", "new-name") },
	});
	await mkdir(oldLayout.sessionDir, { recursive: true });
	const harness = makeHarness(root);
	const originalRename = fsp.rename;
	fsp.rename = (async (from: string) => {
		await rm(from, { recursive: true, force: true });
		throw Object.assign(new Error("gone"), { code: "ENOENT" });
	}) as unknown as typeof fsp.rename;
	t.after(() => {
		fsp.rename = originalRename;
	});

	// Execution: drive the move while the old directory vanishes.
	await drive(
		harness.deps,
		movedEvent(sessionID, path.join(root, "workspace", "new-name"), projectID),
	);

	// Assertions: the race is silent, no new directory is fabricated, and state is invalidated.
	assert.equal(await exists(oldLayout.sessionDir), false);
	assert.equal(await exists(newLayout.sessionDir), false);
	assert.deepEqual(harness.forgotten, [sessionID]);
	assert.deepEqual(harness.warnings, []);
	assert.deepEqual(harness.errors, []);
});

test("when_the_rename_fails_then_it_is_logged_once_and_the_old_directory_stays", async (t) => {
	// Setup: two session moves whose renames both fail with a real permission error.
	const root = await makeTmpRoot(t);
	const projectID = "prj_failure";
	const first = resolveLayout(root, {
		sessionID: "ses_A",
		projectID,
		location: { directory: path.join(root, "workspace", "first-old") },
	});
	const second = resolveLayout(root, {
		sessionID: "ses_B",
		projectID,
		location: { directory: path.join(root, "workspace", "second-old") },
	});
	await mkdir(first.sessionDir, { recursive: true });
	await mkdir(second.sessionDir, { recursive: true });
	const harness = makeHarness(root);
	const originalRename = fsp.rename;
	fsp.rename = (async () => {
		throw Object.assign(new Error("denied"), { code: "EACCES" });
	}) as unknown as typeof fsp.rename;
	t.after(() => {
		fsp.rename = originalRename;
	});

	// Execution: drive both events through the loop.
	await drive(
		harness.deps,
		movedEvent("ses_A", path.join(root, "workspace", "first-new"), projectID),
		movedEvent("ses_B", path.join(root, "workspace", "second-new"), projectID),
	);

	// Assertions: failures do not throw or end the loop, the old dirs stay for the sweep, and the warning is deduped.
	assert.equal(await exists(first.sessionDir), true);
	assert.equal(await exists(second.sessionDir), true);
	assert.equal(harness.warnings.length, 1);
	assert.match(harness.warnings[0] ?? "", /could not move scratch directory/);
	assert.match(harness.warnings[0] ?? "", /ses_A/);
	assert.match(harness.warnings[0] ?? "", /denied/);
	assert.deepEqual(harness.forgotten, ["ses_A", "ses_B"]);
	assert.deepEqual(harness.errors, []);
});

test("when_a_project_directory_is_a_symlink_then_delete_leaves_its_target_alone", async (t) => {
	// Setup: a project-shaped symlink under the root pointing at a session tree outside it.
	const root = await makeTmpRoot(t);
	const outside = await makeTmpRoot(t);
	const target = await makeSessionDir(outside, "linked_project", "ses_A");
	const link = path.join(root, "linked_project");
	await symlink(path.join(outside, "linked_project"), link, "dir");
	const harness = makeHarness(root);

	// Execution: drive a delete event for the session behind the link.
	await drive(harness.deps, deletedEvent("ses_A"));

	// Assertions: the scan skips the link, so both the link and its target stay.
	assert.equal(await exists(link), true);
	assert.equal(await exists(target), true);
	assert.deepEqual(harness.errors, []);
});

test("when_the_subscription_aborts_then_the_loop_ends_without_logging", async (t) => {
	// Setup: an iterable that raises the abort error a stopped subscription produces.
	const root = await makeTmpRoot(t);
	const harness = makeHarness(root);
	const aborting: AsyncIterable<LifecycleEvent> = {
		[Symbol.asyncIterator]: () => ({
			next: async () => {
				throw Object.assign(new Error("aborted"), { name: "AbortError" });
			},
		}),
	};

	// Execution: run the loop to termination.
	await subscribeLifecycle(aborting, harness.deps);

	// Assertions: cleanup-time aborts are normal termination, not failures.
	assert.deepEqual(harness.warnings, []);
	assert.deepEqual(harness.errors, []);
});

test("when_the_subscription_fails_for_another_reason_then_the_error_is_logged", async (t) => {
	// Setup: an iterable that raises a transport error.
	const root = await makeTmpRoot(t);
	const harness = makeHarness(root);
	const failing: AsyncIterable<LifecycleEvent> = {
		[Symbol.asyncIterator]: () => ({
			next: async () => {
				throw new Error("boom");
			},
		}),
	};

	// Execution: run the loop to termination.
	await subscribeLifecycle(failing, harness.deps);

	// Assertions: the failure resolves the loop instead of rejecting and is reported.
	assert.equal(harness.errors.length, 1);
	assert.match(
		harness.errors[0] ?? "",
		/scratch lifecycle subscription failed/,
	);
	assert.match(harness.errors[0] ?? "", /boom/);
});
