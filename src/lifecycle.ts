/**
 * Session lifecycle handling (README "Session lifecycle").
 *
 * `subscribeLifecycle` consumes the core event stream, dispatches the three events the plugin handles, and
 * terminates cleanly on abort. The delete and archive handlers scan project directories and remove the session
 * tree; the move handler renames it to the layout derived from the event, merging into an occupied destination.
 *
 * Handlers are best effort and idempotent: a missing directory is success, a failed removal or move is logged
 * without throwing, and per-session state is invalidated even when the filesystem action fails. Registration,
 * the abort controller, and the timers live in `index.ts` (M6).
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { isDestinationExists, isMissing } from "./fs-errors.ts";
import { resolveLayout, sessionSegment } from "./layout.ts";
import { type Logger, type WarnState, warnOnce } from "./logging.ts";

/** Dependencies for the session lifecycle loop, injected by `index.ts` so tests need no transport. */
export interface LifecycleDeps {
	readonly root: string;
	readonly cleanupOnDelete: boolean;
	readonly cleanupOnArchive: boolean;
	readonly logger: Logger;
	/** Warning kinds already logged by this plugin instance. */
	readonly warnState: WarnState;
	/** Clears the session resolver memo, the mkdir cache, and the disabled-enrichment set. */
	readonly forgetSession: (sessionID: string) => void;
}

/** The `session.moved` payload that decides the new scratch layout. */
export interface MovedSessionData {
	readonly sessionID: string;
	readonly projectID: string;
	readonly location: { readonly directory: string };
}

/**
 * The lifecycle events the plugin handles, narrowed to the fields it reads. The core stream is broader, but a
 * `subscribe` call filtered by these types must be assignable here, so an upstream field rename fails the M6
 * type check instead of silently falling back to `global`.
 */
export type LifecycleEvent =
	| {
			readonly type: "session.deleted";
			readonly data: { readonly sessionID: string };
	  }
	| {
			readonly type: "session.archived";
			readonly data: { readonly sessionID: string };
	  }
	| { readonly type: "session.moved"; readonly data: MovedSessionData };

/**
 * Consumes the lifecycle subscription until it ends. Events are handled sequentially, a failing handler
 * does not end the loop, and an abort is normal termination because cleanup stops the subscription.
 */
export async function subscribeLifecycle(
	events: AsyncIterable<LifecycleEvent>,
	deps: LifecycleDeps,
): Promise<void> {
	try {
		for await (const event of events) {
			try {
				await handleLifecycleEvent(event, deps);
			} catch (error) {
				deps.logger.error(
					"scratch lifecycle handler failed for %s: %s",
					event.type,
					error,
				);
			}
		}
	} catch (error) {
		if (!isAbortError(error))
			deps.logger.error("scratch lifecycle subscription failed: %s", error);
	}
}

async function handleLifecycleEvent(
	event: LifecycleEvent,
	deps: LifecycleDeps,
): Promise<void> {
	if (event.type === "session.deleted") {
		if (deps.cleanupOnDelete)
			await removeSessionDirectories(
				deps.root,
				event.data.sessionID,
				deps.logger,
			);
		deps.forgetSession(event.data.sessionID);
		return;
	}

	if (event.type === "session.archived") {
		if (!deps.cleanupOnArchive) return;
		await removeSessionDirectories(
			deps.root,
			event.data.sessionID,
			deps.logger,
		);
		deps.forgetSession(event.data.sessionID);
		return;
	}

	await moveSession(event.data, deps);
}

/**
 * Renames the session's old directory to the event's new layout. When the destination exists, entries move
 * one by one and clashes are skipped, so the old directory is left for the sweep. State is forgotten even
 * when the move fails, so the next model call resolves the new path.
 */
async function moveSession(
	data: MovedSessionData,
	deps: LifecycleDeps,
): Promise<void> {
	try {
		const layout = resolveLayout(deps.root, {
			sessionID: data.sessionID,
			projectID: data.projectID,
			location: data.location,
		});
		const matches = await findSessionDirectories(
			deps.root,
			sessionSegment(data.sessionID),
			deps.logger,
		);
		const oldDir = matches.find((dir) => dir !== layout.sessionDir);
		if (oldDir === undefined) return;

		await fsp.mkdir(layout.projectDir, { recursive: true, mode: 0o700 });
		await moveDirectory(oldDir, layout.sessionDir);
	} catch (error) {
		if (!isMissing(error)) {
			warnOnce(
				deps.warnState,
				"rename",
				deps.logger,
				"could not move scratch directory for session %s: %s",
				data.sessionID,
				error,
			);
		}
	} finally {
		deps.forgetSession(data.sessionID);
	}
}

async function moveDirectory(from: string, to: string): Promise<void> {
	try {
		await fsp.rename(from, to);
		return;
	} catch (error) {
		if (isMissing(error)) return;
		if (!isDestinationExists(error)) throw error;
	}

	for (const name of await fsp.readdir(from)) {
		const target = path.join(to, name);
		try {
			await fsp.lstat(target);
			continue;
		} catch (error) {
			if (!isMissing(error)) throw error;
		}

		try {
			await fsp.rename(path.join(from, name), target);
		} catch (error) {
			if (isMissing(error) || isDestinationExists(error)) continue;
			throw error;
		}
	}
}

/** Removes every `<root>/<project>/<sessionSegment(sessionID)>` directory, ignoring missing ones. */
async function removeSessionDirectories(
	root: string,
	sessionID: string,
	logger: Logger,
): Promise<void> {
	const matches = await findSessionDirectories(
		root,
		sessionSegment(sessionID),
		logger,
	);
	for (const match of matches) {
		try {
			await fsp.rm(match, { recursive: true, force: true });
		} catch (error) {
			if (!isMissing(error))
				logger.error("scratch lifecycle could not remove %s: %s", match, error);
		}
	}
}

/** Scans immediate project directories without following symlinked projects. */
async function findSessionDirectories(
	root: string,
	segment: string,
	logger: Logger,
): Promise<string[]> {
	let names: string[];
	try {
		names = await fsp.readdir(root);
	} catch (error) {
		if (!isMissing(error))
			logger.error("scratch lifecycle could not read %s: %s", root, error);
		return [];
	}

	const matches: string[] = [];
	for (const name of names) {
		const projectDir = path.join(root, name);
		try {
			if (!(await fsp.lstat(projectDir)).isDirectory()) continue;
			const candidate = path.join(projectDir, segment);
			if ((await fsp.lstat(candidate)).isDirectory()) matches.push(candidate);
		} catch (error) {
			if (!isMissing(error))
				logger.error("scratch lifecycle failed for %s: %s", projectDir, error);
		}
	}
	return matches;
}

function isAbortError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	if ("name" in error && error.name === "AbortError") return true;
	return "code" in error && error.code === "ABORT_ERR";
}
