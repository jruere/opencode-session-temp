/**
 * Covers age-based cleanup from README "Cleanup": the strict atime/mtime predicate, bottom-up pruning, symlink and
 * special-file handling, race tolerance, partial failure, and the hourly timer. Filesystem cases pin documented
 * examples and real tree behavior; generated cases check the pure policy (`isStale`, `entryKind`, `childRole`,
 * `decideEntry`) with boundary-biased inputs.
 *
 * Does not cover lifecycle events, the subscription loop (M5), or option parsing (M6). Every filesystem test uses a
 * fresh real temporary root, a fixed clock, and `utimes`/`lutimes`; no test waits for a real timer. The generated
 * cases are pure and do not build a filesystem tree.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import {
	lstat,
	lutimes,
	mkdir,
	rm,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { type TestContext, test } from "node:test";
import { format, promisify } from "node:util";
import fc from "fast-check";
import { isSessionSegment } from "../src/layout.ts";
import type { Logger } from "../src/logging.ts";
import {
	childRole,
	decideEntry,
	type EntryKind,
	type EntryRole,
	entryKind,
	isStale,
	startSweepTimer,
	sweepOnce,
} from "../src/sweep.ts";
import { makeTmpRoot } from "./helpers/tmp-root.ts";

const maxAgeHours = 48;
const now = 1_700_000_000_000;
const cutoffMs = now - maxAgeHours * 3_600_000;
const staleTime = new Date(cutoffMs - 60_000);
const freshTime = new Date(cutoffMs + 60_000);
const cutoffTime = new Date(cutoffMs);
const execFileAsync = promisify(execFile);

function makeLogger(): {
	logger: Logger;
	warnings: string[];
	errors: string[];
} {
	const warnings: string[] = [];
	const errors: string[] = [];
	const logger: Logger = {
		warn: (message, ...args) => warnings.push(format(message, ...args)),
		error: (message, ...args) => errors.push(format(message, ...args)),
	};
	return { logger, warnings, errors };
}

function sweep(root: string, logger: Logger): Promise<void> {
	return sweepOnce(root, { maxAgeHours, now, logger });
}

async function writeAt(file: string, atime: Date, mtime: Date): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, "data");
	await utimes(file, atime, mtime);
}

async function exists(target: string): Promise<boolean> {
	try {
		await lstat(target);
		return true;
	} catch {
		return false;
	}
}

/** Patches the global interval functions and exposes the registered tick and cleanup. */
function makeTimerHarness(t: TestContext): {
	fire: () => void;
	intervalMs: () => number | undefined;
	unrefCalls: () => number;
	handle: unknown;
	cleared: () => unknown;
} {
	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	let callback: (() => void) | undefined;
	let intervalMs: number | undefined;
	let unrefCalls = 0;
	let cleared: unknown;
	const fakeTimer = {
		unref: () => {
			unrefCalls++;
		},
	};

	globalThis.setInterval = ((fn: () => void, ms: number) => {
		callback = fn;
		intervalMs = ms;
		return fakeTimer;
	}) as unknown as typeof setInterval;
	globalThis.clearInterval = ((timer: unknown) => {
		cleared = timer;
	}) as unknown as typeof clearInterval;
	t.after(() => {
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
	});

	return {
		fire: () => callback?.(),
		intervalMs: () => intervalMs,
		unrefCalls: () => unrefCalls,
		handle: fakeTimer,
		cleared: () => cleared,
	};
}

test("when_a_file_is_older_than_the_cutoff_then_it_is_deleted", async (t) => {
	// Setup: one stale file beside a fresh one that keeps the session directory alive.
	const root = await makeTmpRoot(t);
	const sessionDir = path.join(root, "example_project", "ses_A");
	const staleFile = path.join(sessionDir, "old.txt");
	const freshFile = path.join(sessionDir, "new.txt");
	await writeAt(staleFile, staleTime, staleTime);
	await writeAt(freshFile, freshTime, freshTime);
	const { logger, errors } = makeLogger();

	// Execution: run one sweep with a fixed clock.
	await sweep(root, logger);

	// Assertions: only the stale file is gone and nothing failed.
	assert.equal(await exists(staleFile), false);
	assert.equal(await exists(freshFile), true);
	assert.deepEqual(errors, []);
});

test("when_atime_is_fresh_and_mtime_is_stale_then_it_keeps_the_file", async (t) => {
	// Setup: a file read recently but written long ago.
	const root = await makeTmpRoot(t);
	const file = path.join(root, "example_project", "ses_A", "read.txt");
	await writeAt(file, freshTime, staleTime);
	const { logger } = makeLogger();

	// Execution: sweep the tree.
	await sweep(root, logger);

	// Assertions: a fresh access time protects the file.
	assert.equal(await exists(file), true);
});

test("when_mtime_is_fresh_and_atime_is_stale_then_it_keeps_the_file", async (t) => {
	// Setup: a file written recently but not read since an old backup.
	const root = await makeTmpRoot(t);
	const file = path.join(root, "example_project", "ses_A", "written.txt");
	await writeAt(file, staleTime, freshTime);
	const { logger } = makeLogger();

	// Execution: sweep the tree.
	await sweep(root, logger);

	// Assertions: a fresh modification time protects the file.
	assert.equal(await exists(file), true);
});

test("when_both_times_equal_the_cutoff_then_it_keeps_the_file", async (t) => {
	// Setup: a file whose times are exactly the strict cutoff boundary.
	const root = await makeTmpRoot(t);
	const file = path.join(root, "example_project", "ses_A", "boundary.txt");
	await writeAt(file, cutoffTime, cutoffTime);
	const { logger } = makeLogger();

	// Execution: sweep the tree.
	await sweep(root, logger);

	// Assertions: an entry exactly at the cutoff is fresh and kept.
	assert.equal(await exists(file), true);
});

test("when_a_project_directory_is_a_symlink_then_it_is_skipped", async (t) => {
	// Setup: a symlinked project directory pointing at a stale tree outside the root.
	const root = await makeTmpRoot(t);
	const outside = await makeTmpRoot(t);
	const outsideFile = path.join(outside, "ses_A", "old.txt");
	await writeAt(outsideFile, staleTime, staleTime);
	const link = path.join(root, "linked_project");
	await symlink(outside, link, "dir");
	const { logger } = makeLogger();

	// Execution: sweep the root.
	await sweep(root, logger);

	// Assertions: neither the link nor the target tree is touched.
	assert.equal(await exists(link), true);
	assert.equal(await exists(outsideFile), true);
});

test("when_an_entry_is_not_a_session_name_then_it_is_untouched", async (t) => {
	// Setup: a stale file inside a non-session directory and a stale loose file inside the project.
	const root = await makeTmpRoot(t);
	const projectDir = path.join(root, "example_project");
	const sharedFile = path.join(projectDir, "shared", "old.txt");
	const looseFile = path.join(projectDir, "notes.txt");
	const sessionFile = path.join(projectDir, "ses_A", "old.txt");
	await writeAt(sharedFile, staleTime, staleTime);
	await writeAt(looseFile, staleTime, staleTime);
	await writeAt(sessionFile, staleTime, staleTime);
	const { logger } = makeLogger();

	// Execution: sweep the root.
	await sweep(root, logger);

	// Assertions: only names matching the session pattern are considered.
	assert.equal(await exists(sharedFile), true);
	assert.equal(await exists(looseFile), true);
	assert.equal(await exists(sessionFile), false);
});

test("when_a_session_name_is_a_leaf_then_only_stale_entries_are_removed", async (t) => {
	// Setup: stale and fresh regular files and a stale symlink named like sessions under one project.
	const root = await makeTmpRoot(t);
	const projectDir = path.join(root, "example_project");
	const staleFile = path.join(projectDir, "ses_stale_file");
	const freshFile = path.join(projectDir, "ses_fresh_file");
	const staleLink = path.join(projectDir, "ses_stale_link");
	const targetFile = path.join(root, "target.txt");
	await writeAt(staleFile, staleTime, staleTime);
	await writeAt(freshFile, freshTime, freshTime);
	await writeAt(targetFile, freshTime, freshTime);
	await symlink(targetFile, staleLink);
	await lutimes(staleLink, staleTime, staleTime);
	const { logger, errors } = makeLogger();

	// Execution: sweep the root.
	await sweep(root, logger);

	// Assertions: stale leaves go, fresh and target entries stay, and nothing failed.
	assert.equal(await exists(staleFile), false);
	assert.equal(await exists(staleLink), false);
	assert.equal(await exists(freshFile), true);
	assert.equal(await exists(targetFile), true);
	assert.equal(await exists(projectDir), true);
	assert.deepEqual(errors, []);
});

test("when_a_loose_file_is_directly_under_the_root_then_it_is_untouched", async (t) => {
	// Setup: a stale loose file under the root beside a project that will be swept.
	const root = await makeTmpRoot(t);
	const looseFile = path.join(root, "notes.txt");
	const sessionFile = path.join(root, "example_project", "ses_A", "old.txt");
	await writeAt(looseFile, staleTime, staleTime);
	await writeAt(sessionFile, staleTime, staleTime);
	const { logger } = makeLogger();

	// Execution: sweep the root.
	await sweep(root, logger);

	// Assertions: the root's loose files are out of scope, while the session tree is swept.
	assert.equal(await exists(looseFile), true);
	assert.equal(await exists(sessionFile), false);
});

test("when_a_symlink_is_stale_then_the_link_is_removed_and_its_fresh_target_is_untouched", async (t) => {
	// Setup: a stale symlink inside a session that points at a fresh file directly under the root.
	const root = await makeTmpRoot(t);
	const targetFile = path.join(root, "target.txt");
	await writeAt(targetFile, freshTime, freshTime);
	const sessionDir = path.join(root, "example_project", "ses_A");
	await mkdir(sessionDir, { recursive: true });
	const link = path.join(sessionDir, "link.txt");
	await symlink(targetFile, link);
	await lutimes(link, staleTime, staleTime);
	const { logger } = makeLogger();

	// Execution: sweep the root.
	await sweep(root, logger);

	// Assertions: the link's own times decide and the target is never followed or deleted.
	assert.equal(await exists(link), false);
	assert.equal(await exists(targetFile), true);
});

test("when_an_entry_is_a_fifo_then_it_is_left_alone", async (t) => {
	// Setup: a stale FIFO inside a session directory.
	const root = await makeTmpRoot(t);
	const sessionDir = path.join(root, "example_project", "ses_A");
	const fifo = path.join(sessionDir, "pipe");
	await mkdir(sessionDir, { recursive: true });
	await execFileAsync("mkfifo", [fifo]);
	await utimes(fifo, staleTime, staleTime);
	const { logger } = makeLogger();

	// Execution: sweep the root.
	await sweep(root, logger);

	// Assertions: special files are not regular files or symlinks, so they survive.
	assert.equal(await exists(fifo), true);
});

test("when_empty_directories_remain_then_they_are_pruned_bottom_up", async (t) => {
	// Setup: empty nested directories, a stale file in a nested directory, and a fresh file.
	const root = await makeTmpRoot(t);
	const sessionDir = path.join(root, "example_project", "ses_A");
	const emptyDir = path.join(sessionDir, "empty");
	const nestedDir = path.join(sessionDir, "nested");
	const freshFile = path.join(sessionDir, "fresh.txt");
	await mkdir(path.join(emptyDir, "deeper"), { recursive: true });
	await writeAt(path.join(nestedDir, "old.txt"), staleTime, staleTime);
	await writeAt(freshFile, freshTime, freshTime);
	const { logger } = makeLogger();

	// Execution: sweep the root.
	await sweep(root, logger);

	// Assertions: empty directories disappear after their children; the session survives on its fresh file.
	assert.equal(await exists(emptyDir), false);
	assert.equal(await exists(nestedDir), false);
	assert.equal(await exists(freshFile), true);
	assert.equal(await exists(sessionDir), true);
});

test("when_all_children_are_stale_then_the_session_and_project_directories_are_removed", async (t) => {
	// Setup: a session whose only file is stale.
	const root = await makeTmpRoot(t);
	const projectDir = path.join(root, "example_project");
	const sessionDir = path.join(projectDir, "ses_A");
	await writeAt(path.join(sessionDir, "old.txt"), staleTime, staleTime);
	const { logger } = makeLogger();

	// Execution: sweep the root.
	await sweep(root, logger);

	// Assertions: pruning reaches and removes both empty parents, but never the root.
	assert.equal(await exists(sessionDir), false);
	assert.equal(await exists(projectDir), false);
	assert.equal(await exists(root), true);
});

test("when_the_root_does_not_exist_then_the_sweep_completes_without_error", async (t) => {
	// Setup: a path under the temporary root that was never created.
	const root = await makeTmpRoot(t);
	const missing = path.join(root, "missing");
	const { logger, errors } = makeLogger();

	// Execution: sweep the missing root.
	await sweep(missing, logger);

	// Assertions: a missing root is success and nothing is logged.
	assert.deepEqual(errors, []);
});

test("when_the_root_cannot_be_read_then_the_failure_is_logged_and_nothing_is_swept", async (t) => {
	// Setup: a stale tree and a root whose directory listing is denied.
	const root = await makeTmpRoot(t);
	const file = path.join(root, "example_project", "ses_A", "old.txt");
	await writeAt(file, staleTime, staleTime);
	const { logger, errors } = makeLogger();
	const originalReaddir = fsp.readdir;
	fsp.readdir = (async (target: string) => {
		if (target === root) {
			throw Object.assign(new Error("denied"), { code: "EACCES" });
		}
		return originalReaddir(target);
	}) as unknown as typeof fsp.readdir;
	t.after(() => {
		fsp.readdir = originalReaddir;
	});

	// Execution: sweep the root.
	await sweep(root, logger);

	// Assertions: the root-level failure is logged and the stale tree is untouched.
	assert.equal(await exists(file), true);
	assert.equal(errors.length, 1);
	assert.match(errors[0] ?? "", /could not read/);
	assert.match(errors[0] ?? "", /denied/);
});

test("when_an_entry_disappears_between_the_scan_and_the_action_then_the_sweep_completes", async (t) => {
	// Setup: two stale files, with `lstat` deleting the first just after it reports it as stale.
	const root = await makeTmpRoot(t);
	const sessionDir = path.join(root, "example_project", "ses_A");
	const racedFile = path.join(sessionDir, "raced.txt");
	const otherFile = path.join(sessionDir, "other.txt");
	await writeAt(racedFile, staleTime, staleTime);
	await writeAt(otherFile, staleTime, staleTime);
	const { logger, errors } = makeLogger();
	const originalLstat = fsp.lstat;
	let raced = false;
	fsp.lstat = (async (target: string) => {
		const stats = await originalLstat(target);
		if (!raced && target === racedFile) {
			raced = true;
			await rm(racedFile, { force: true });
		}
		return stats;
	}) as unknown as typeof fsp.lstat;
	t.after(() => {
		fsp.lstat = originalLstat;
	});

	// Execution: sweep the root with the race in place.
	await sweep(root, logger);

	// Assertions: the vanished entry is ignored and the rest of the sweep still runs.
	assert.equal(raced, true);
	assert.equal(await exists(racedFile), false);
	assert.equal(await exists(otherFile), false);
	assert.deepEqual(errors, []);
});

test("when_one_project_fails_then_other_projects_are_still_swept", async (t) => {
	// Setup: one project whose directory cannot be listed and one healthy stale project.
	const root = await makeTmpRoot(t);
	const failingProject = path.join(root, "failing_project");
	const failingFile = path.join(failingProject, "ses_A", "old.txt");
	const healthyFile = path.join(root, "healthy_project", "ses_A", "old.txt");
	await writeAt(failingFile, staleTime, staleTime);
	await writeAt(healthyFile, staleTime, staleTime);
	const { logger, errors } = makeLogger();
	const originalReaddir = fsp.readdir;
	fsp.readdir = (async (target: string) => {
		if (target === failingProject) {
			throw Object.assign(new Error("denied"), { code: "EACCES" });
		}
		return originalReaddir(target);
	}) as unknown as typeof fsp.readdir;
	t.after(() => {
		fsp.readdir = originalReaddir;
	});

	// Execution: sweep the root.
	await sweep(root, logger);

	// Assertions: the failure is logged and the healthy project is still swept.
	assert.equal(await exists(healthyFile), false);
	assert.equal(await exists(failingFile), true);
	assert.equal(errors.length, 1);
	assert.match(errors[0] ?? "", /failing_project/);
});

test("when_one_entry_fails_then_the_rest_of_the_session_is_still_swept", async (t) => {
	// Setup: two stale files where reading one of them is denied.
	const root = await makeTmpRoot(t);
	const sessionDir = path.join(root, "example_project", "ses_A");
	const failingFile = path.join(sessionDir, "denied.txt");
	const otherFile = path.join(sessionDir, "other.txt");
	await writeAt(failingFile, staleTime, staleTime);
	await writeAt(otherFile, staleTime, staleTime);
	const { logger, errors } = makeLogger();
	const originalLstat = fsp.lstat;
	fsp.lstat = (async (target: string) => {
		if (target === failingFile) {
			throw Object.assign(new Error("denied"), { code: "EACCES" });
		}
		return originalLstat(target);
	}) as unknown as typeof fsp.lstat;
	t.after(() => {
		fsp.lstat = originalLstat;
	});

	// Execution: sweep the root.
	await sweep(root, logger);

	// Assertions: the failure is logged and the sibling is still removed.
	assert.equal(await exists(failingFile), true);
	assert.equal(await exists(otherFile), false);
	assert.equal(errors.length, 1);
	assert.match(errors[0] ?? "", /denied\.txt/);
	assert.match(errors[0] ?? "", /denied/);
});

test("when_two_sweeps_run_concurrently_then_they_are_idempotent_and_do_not_throw", async (t) => {
	// Setup: a stale tree shared by two simultaneous sweeps.
	const root = await makeTmpRoot(t);
	const file = path.join(root, "example_project", "ses_A", "old.txt");
	await writeAt(file, staleTime, staleTime);
	const { logger, errors } = makeLogger();

	// Execution: start both sweeps without awaiting the first.
	await Promise.all([sweep(root, logger), sweep(root, logger)]);

	// Assertions: one sweep wins the removals, the other tolerates the races, and the root survives.
	assert.equal(await exists(file), false);
	assert.equal(await exists(root), true);
	assert.deepEqual(errors, []);
});

test("when_the_sweep_timer_starts_then_it_registers_an_unrefed_interval_and_stop_clears_it", async (t) => {
	// Setup: patched global timers that record registration and cleanup.
	const { logger, errors } = makeLogger();
	const timers = makeTimerHarness(t);
	let sweeps = 0;

	// Execution: start the timer, fire one tick, then stop it.
	const subject = startSweepTimer(
		async () => {
			sweeps++;
		},
		3_600_000,
		logger,
	);
	timers.fire();
	await Promise.resolve();
	subject.stop();

	// Assertions: one hourly registration, unref once, one tick, and stop clears the handle.
	assert.equal(timers.intervalMs(), 3_600_000);
	assert.equal(timers.unrefCalls(), 1);
	assert.equal(sweeps, 1);
	assert.equal(timers.cleared(), timers.handle);
	assert.deepEqual(errors, []);
});

test("when_a_timer_tick_rejects_then_the_error_is_logged_and_the_timer_survives", async (t) => {
	// Setup: a timer whose sweep always rejects.
	const { logger, errors } = makeLogger();
	const timers = makeTimerHarness(t);

	// Execution: start the timer, fire one tick, and let the rejection settle.
	const subject = startSweepTimer(
		async () => {
			throw new Error("boom");
		},
		60_000,
		logger,
	);
	timers.fire();
	await new Promise((resolve) => setImmediate(resolve));
	subject.stop();

	// Assertions: the failure is logged instead of escaping, and stop still clears the handle.
	assert.equal(errors.length, 1);
	assert.match(errors[0] ?? "", /scratch sweep failed/);
	assert.match(errors[0] ?? "", /boom/);
	assert.notEqual(timers.cleared(), undefined);
});

// ---------------------------------------------------------------------------
// Generated properties
// ---------------------------------------------------------------------------
// The filesystem cases above pin documented examples and races. The properties below check the pure policy with
// boundary-biased inputs: the strict cutoff rule, the `lstat` kind priority, name-scope classification, and the
// decision matrix. No generated case touches the filesystem.

/** Times and cutoffs around a signed range, so ordering and equality are both generated. */
const timeArb = fc.integer({
	min: -2_000_000_000_000,
	max: 2_000_000_000_000,
});
const cutoffArb = fc.integer({
	min: -1_000_000_000_000,
	max: 1_000_000_000_000,
});
const nonNegativeDeltaArb = fc.integer({
	min: 0,
	max: 1_000_000_000_000,
});

test("when_access_and_modification_times_are_swapped_then_staleness_is_unchanged", () => {
	// Setup: arbitrary times and cutoffs.

	// Execution: compare each entry with its two times swapped.
	fc.assert(
		fc.property(timeArb, timeArb, cutoffArb, (atimeMs, mtimeMs, cutoffMs) => {
			const original = isStale({ atimeMs, mtimeMs }, cutoffMs);
			const subject = isStale({ atimeMs: mtimeMs, mtimeMs: atimeMs }, cutoffMs);

			// Assertions: only the older of the two times decides.
			assert.equal(subject, original);
		}),
	);
});

test("when_both_times_are_strictly_before_the_cutoff_then_the_entry_is_stale", () => {
	// Setup: a cutoff and two positive offsets, so both times are strictly older.

	// Execution: classify each generated triple.
	fc.assert(
		fc.property(
			cutoffArb,
			fc.integer({ min: 1, max: 1_000_000_000_000 }),
			fc.integer({ min: 1, max: 1_000_000_000_000 }),
			(cutoffMs, atimeOffset, mtimeOffset) => {
				const subject = isStale(
					{
						atimeMs: cutoffMs - atimeOffset,
						mtimeMs: cutoffMs - mtimeOffset,
					},
					cutoffMs,
				);

				// Assertions: the strict rule makes any older pair stale.
				assert.equal(subject, true);
			},
		),
	);
});

test("when_either_time_is_at_or_after_the_cutoff_then_the_entry_is_fresh", () => {
	// Setup: one time at or after the cutoff and the other at or before it.

	// Execution: classify each generated pair in both assignments.
	fc.assert(
		fc.property(
			cutoffArb,
			nonNegativeDeltaArb,
			nonNegativeDeltaArb,
			fc.boolean(),
			(cutoffMs, atimeOffset, mtimeOffset, atimeIsNewer) => {
				const older = cutoffMs - atimeOffset;
				const newer = cutoffMs + mtimeOffset;
				const subject = isStale(
					{
						atimeMs: atimeIsNewer ? newer : older,
						mtimeMs: atimeIsNewer ? older : newer,
					},
					cutoffMs,
				);

				// Assertions: a time at the cutoff is fresh, and so is any later time.
				assert.equal(subject, false);
			},
		),
	);
});

test("when_the_cutoff_moves_later_then_staleness_is_monotone", () => {
	// Setup: arbitrary times and two cutoffs where the second is not earlier.

	// Execution: classify each entry against both cutoffs.
	fc.assert(
		fc.property(
			timeArb,
			timeArb,
			cutoffArb,
			nonNegativeDeltaArb,
			(atimeMs, mtimeMs, cutoffMs, deltaMs) => {
				const original = isStale({ atimeMs, mtimeMs }, cutoffMs);
				const subject = isStale({ atimeMs, mtimeMs }, cutoffMs + deltaMs);

				// Assertions: a stale entry stays stale when the cutoff moves later.
				assert.ok(!original || subject);
			},
		),
	);
});

interface LstatFlags {
	readonly isDirectory: boolean;
	readonly isFile: boolean;
	readonly isSymbolicLink: boolean;
}

const lstatFlagsArb: fc.Arbitrary<LstatFlags> = fc.record({
	isDirectory: fc.boolean(),
	isFile: fc.boolean(),
	isSymbolicLink: fc.boolean(),
});

function expectedKind(flags: LstatFlags): EntryKind {
	if (flags.isDirectory) return "directory";
	if (flags.isSymbolicLink) return "symlink";
	if (flags.isFile) return "file";
	return "other";
}

test("when_lstat_flags_overlap_then_the_kind_follows_the_directory_symlink_file_priority", () => {
	// Setup: every combination of the three booleans that `lstat` can report.

	// Execution: map each combination twice.
	fc.assert(
		fc.property(lstatFlagsArb, (flags) => {
			const subject = entryKind(flags);
			const repeated = entryKind(flags);

			// Assertions: the first true flag in priority order wins, and the mapping is deterministic.
			assert.equal(subject, expectedKind(flags));
			assert.equal(repeated, subject);
		}),
	);
});

const entryKinds = [
	"directory",
	"file",
	"symlink",
	"other",
] as const satisfies readonly EntryKind[];
const entryRoles = [
	"project",
	"session",
	"nested",
	"outside",
] as const satisfies readonly EntryRole[];
const entryKindArb = fc.constantFrom(...entryKinds);
const entryRoleArb = fc.constantFrom(...entryRoles);
const childParentArb = fc.constantFrom("project", "session");

/** Names biased toward the session-pattern boundary and away from it. */
const childNameArb = fc.oneof(
	fc.string(),
	fc.stringMatching(/^ses[A-Za-z0-9._-]+$/),
	fc.constantFrom("ses", `ses${path.sep}`, "..", "", "SES_upper", "shared"),
);

test("when_a_child_is_classified_then_project_scope_uses_the_session_pattern_and_session_scope_is_nested", () => {
	// Setup: both parent scopes and names on either side of the session pattern.

	// Execution: classify each child twice.
	fc.assert(
		fc.property(childParentArb, childNameArb, (parent, name) => {
			const subject = childRole({ parent, name });
			let expected: EntryRole;
			if (parent === "session") expected = "nested";
			else expected = isSessionSegment(name) ? "session" : "outside";

			// Assertions: only project children named like sessions are scoped; every session child is nested.
			assert.equal(subject, expected);
			assert.equal(childRole({ parent, name }), subject);
		}),
	);
});

const decisionInputArb = fc.record({
	kind: entryKindArb,
	role: entryRoleArb,
	stale: fc.boolean(),
});

test("when_an_entry_is_decided_then_traverse_and_remove_follow_the_scope_policy", () => {
	// Setup: every kind, role, and staleness combination.

	// Execution: decide each entry.
	fc.assert(
		fc.property(decisionInputArb, (input) => {
			const subject = decideEntry(input);
			const leaf = input.kind === "file" || input.kind === "symlink";
			const scoped = input.role === "session" || input.role === "nested";

			// Assertions: traversal is directory-only and scope-gated; removal is leaf-only, scoped, and stale.
			// These exact formulas also make both flags monotone in `stale`, so that law has no separate assertion.
			assert.equal(
				subject.traverse,
				input.kind === "directory" && input.role !== "outside",
			);
			assert.equal(subject.remove, leaf && scoped && input.stale);
			assert.equal(subject.traverse && subject.remove, false);
		}),
	);
});
