/**
 * Age-based cleanup for the scratch root (README "Cleanup").
 *
 * `isStale`, `entryKind`, `childRole`, and `decideEntry` hold the pure policy: plain data in, plain
 * decisions out, no filesystem access. `sweepOnce` is the filesystem walker: it maps `lstat` into
 * plain data, asks the policy what to traverse or unlink, prunes empty directories bottom-up, and
 * isolates per-entry errors. `startSweepTimer` owns the hourly interval. Lifecycle handlers and the
 * subscription loop are M5.
 *
 * Errors are best effort: a missing entry is success, and one failing entry, session, or project is logged
 * without stopping the rest of the sweep.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { isSessionSegment } from "./layout.ts";

/** Logging surface injected by `index.ts`; defaults to `console` there. */
export type Logger = {
	warn: (message: string, ...args: unknown[]) => void;
	error: (message: string, ...args: unknown[]) => void;
};

/** Warning kinds deduplicated once per plugin instance. */
export type WarnKind =
	| "missing-source"
	| "replacement-miss"
	| "mkdir"
	| "rename";

/** The per-instance state a warning helper needs. */
export interface WarnState {
	readonly warned: Set<string>;
}

/** Logs a warning at most once per plugin instance for a given kind. */
export function warnOnce(
	state: WarnState,
	kind: WarnKind,
	logger: Logger,
	message: string,
	...args: unknown[]
): void {
	if (state.warned.has(kind)) return;
	state.warned.add(kind);
	logger.warn(message, ...args);
}

export interface SweepOptions {
	readonly maxAgeHours: number;
	readonly now: number;
	readonly logger: Logger;
}

/** A file is stale only when both its access and modification times are older than the cutoff. */
export function isStale(
	stats: { atimeMs: number; mtimeMs: number },
	cutoffMs: number,
): boolean {
	return Math.max(stats.atimeMs, stats.mtimeMs) < cutoffMs;
}

/** What an entry is, as plain data derived from `lstat`. */
export type EntryKind = "directory" | "file" | "symlink" | "other";

/** Maps `lstat` booleans to the kinds the policy cares about. */
export function entryKind(stats: {
	isDirectory: boolean;
	isFile: boolean;
	isSymbolicLink: boolean;
}): EntryKind {
	if (stats.isDirectory) return "directory";
	if (stats.isSymbolicLink) return "symlink";
	if (stats.isFile) return "file";
	return "other";
}

/** Where an entry sits relative to the project/session scope. */
export type EntryRole = "project" | "session" | "nested" | "outside";

/** Scope of a child name under a parent directory: the policy part of the walker. */
export function childRole(input: {
	parent: "project" | "session";
	name: string;
}): EntryRole {
	if (input.parent === "project") {
		return isSessionSegment(input.name) ? "session" : "outside";
	}
	return "nested";
}

/** The pure keep/delete policy: walkers only act on these two flags. */
export interface EntryDecision {
	readonly traverse: boolean;
	readonly remove: boolean;
}

/**
 * The pure keep/delete policy. Only regular files and symlinks are removable, and only when stale; project
 * scope only traverses so its leaves are left alone. Symlinked directories are neither traversed nor removed.
 * Emptiness is decided by the walker after children are handled, not here.
 */
export function decideEntry(input: {
	kind: EntryKind;
	role: EntryRole;
	stale: boolean;
}): EntryDecision {
	if (input.kind !== "directory") {
		const remove =
			(input.kind === "file" || input.kind === "symlink") &&
			input.role !== "project" &&
			input.role !== "outside" &&
			input.stale;
		return { traverse: false, remove };
	}
	return { traverse: input.role !== "outside", remove: false };
}

/** Removes stale scratch entries under `root`. Never rejects for filesystem races or missing paths. */
export async function sweepOnce(
	root: string,
	options: SweepOptions,
): Promise<void> {
	const cutoffMs = options.now - options.maxAgeHours * 3_600_000;

	let names: string[];
	try {
		names = await fsp.readdir(root);
	} catch (error) {
		if (!isMissing(error))
			options.logger.error("scratch sweep could not read %s: %s", root, error);
		return;
	}

	for (const name of names) {
		const projectDir = path.join(root, name);
		try {
			await sweepProject(projectDir, cutoffMs, options.logger);
		} catch (error) {
			if (!isMissing(error))
				options.logger.error(
					"scratch sweep failed for %s: %s",
					projectDir,
					error,
				);
		}
	}
}

/** The interval handle returned to `setup` so cleanup can stop it. */
export interface SweepTimer {
	stop: () => void;
}

/** Runs `sweep` every `intervalMs` on an `unref`'d timer that never keeps the process alive. */
export function startSweepTimer(
	sweep: () => Promise<void>,
	intervalMs: number,
	logger: Logger,
): SweepTimer {
	const timer = setInterval(() => {
		sweep().catch((error: unknown) => {
			logger.error("scratch sweep failed: %s", error);
		});
	}, intervalMs);
	timer.unref();

	return { stop: () => clearInterval(timer) };
}

/** Plain snapshot of what the policy needs, taken from one `lstat`. */
type Snapshot = {
	readonly kind: EntryKind;
	readonly stale: boolean;
};

function snapshot(
	stats: {
		isDirectory: () => boolean;
		isFile: () => boolean;
		isSymbolicLink: () => boolean;
		atimeMs: number;
		mtimeMs: number;
	},
	cutoffMs: number,
): Snapshot {
	return {
		kind: entryKind({
			isDirectory: stats.isDirectory(),
			isFile: stats.isFile(),
			isSymbolicLink: stats.isSymbolicLink(),
		}),
		stale: isStale(stats, cutoffMs),
	};
}

async function sweepProject(
	projectDir: string,
	cutoffMs: number,
	logger: Logger,
): Promise<void> {
	const stats = await fsp.lstat(projectDir);
	if (
		entryKind({
			isDirectory: stats.isDirectory(),
			isFile: stats.isFile(),
			isSymbolicLink: stats.isSymbolicLink(),
		}) !== "directory"
	)
		return;

	const names = await fsp.readdir(projectDir);
	for (const name of names) {
		await sweepScopedEntry({
			parent: "project",
			name,
			dir: projectDir,
			cutoffMs,
			logger,
		});
	}

	await removeEmptyDirectory(projectDir);
}

type ScopedEntry = {
	readonly parent: "project" | "session";
	readonly name: string;
	readonly dir: string;
	readonly cutoffMs: number;
	readonly logger: Logger;
};

async function sweepScopedEntry(input: ScopedEntry): Promise<void> {
	const role = childRole({ parent: input.parent, name: input.name });
	if (role === "outside") return;

	const entry = path.join(input.dir, input.name);
	try {
		await sweepEntry(entry, role, input.cutoffMs, input.logger);
	} catch (error) {
		if (!isMissing(error))
			input.logger.error("scratch sweep failed for %s: %s", entry, error);
	}
}

/** Walks one directory depth-first so children go before their parent can be pruned. */
async function sweepContents(
	dir: string,
	cutoffMs: number,
	logger: Logger,
): Promise<void> {
	let names: string[];
	try {
		names = await fsp.readdir(dir);
	} catch (error) {
		if (isMissing(error)) return;
		throw error;
	}

	for (const name of names) {
		await sweepScopedEntry({
			parent: "session",
			name,
			dir,
			cutoffMs,
			logger,
		});
	}
}

async function sweepEntry(
	entry: string,
	role: EntryRole,
	cutoffMs: number,
	logger: Logger,
): Promise<void> {
	let stats: Awaited<ReturnType<typeof fsp.lstat>>;
	try {
		stats = await fsp.lstat(entry);
	} catch (error) {
		if (isMissing(error)) return;
		throw error;
	}

	const snap = snapshot(stats, cutoffMs);
	const decision = decideEntry({ kind: snap.kind, role, stale: snap.stale });
	if (decision.traverse) {
		await sweepContents(entry, cutoffMs, logger);
		await removeEmptyDirectory(entry);
		return;
	}
	if (decision.remove) {
		await removeEntry(entry);
	}
}

async function removeEntry(entry: string): Promise<void> {
	try {
		await fsp.unlink(entry);
	} catch (error) {
		if (!isMissing(error)) throw error;
	}
}

async function removeEmptyDirectory(dir: string): Promise<void> {
	try {
		await fsp.rmdir(dir);
	} catch (error) {
		if (!isMissing(error) && !isNotEmpty(error)) throw error;
	}
}

function isMissing(error: unknown): boolean {
	const code = errorCode(error);
	return code === "ENOENT" || code === "ENOTDIR";
}

function isNotEmpty(error: unknown): boolean {
	const code = errorCode(error);
	return code === "ENOTEMPTY" || code === "EEXIST";
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}
