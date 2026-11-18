/**
 * Model instruction rewriting for the scratch directory (README "Model instructions").
 *
 * `rewriteInstructions` is the pure part: it selects the `core/environment` system part by its instructions metadata,
 * replaces the default scratch path with the session directory, and falls back to a stable appended part. The adapter
 * `applyInstructions` resolves and creates the directory, caches the mkdir result per session, and disables enrichment
 * after a mkdir failure. State is created per plugin instance by the caller so instances never share it.
 */
import { mkdir as fsMkdir } from "node:fs/promises";
import type { SessionLayout } from "./layout.ts";
import { type Logger, warnOnce } from "./logging.ts";

/** A system part as seen by the context hook. Only `text` is ever changed. */
export interface InstructionPart {
	type: string;
	text: string;
	metadata?: Record<string, unknown> | undefined;
}

/** Per-instance state owned by `index.ts`; the lifecycle handlers clear the per-session entries. */
export interface InstructionState {
	/** Cached mkdir promise per session; a rejected promise stays cached until the session is forgotten. */
	readonly mkdirCache: Map<string, Promise<string>>;
	/** Sessions whose directory could not be created and whose instructions are left alone. */
	readonly enrichmentDisabled: Set<string>;
	/** Warning kinds already logged by this plugin instance. */
	readonly warned: Set<string>;
}

/** Creates fresh per-instance state for the instruction adapter. */
export function createInstructionState(): InstructionState {
	return {
		mkdirCache: new Map(),
		enrichmentDisabled: new Set(),
		warned: new Set(),
	};
}

/** Clears a session's cached mkdir and disabled state after a move, delete, or archive cleanup. */
export function forgetSession(
	state: InstructionState,
	sessionID: string,
): void {
	state.mkdirCache.delete(sessionID);
	state.enrichmentDisabled.delete(sessionID);
}

export interface MkdirOptions {
	readonly recursive: boolean;
	readonly mode: number;
}

/** Dependencies injected by `index.ts`; `mkdir` is overridable for failure tests. */
export interface InstructionDeps {
	/**
	 * The core default scratch root, `path.join(os.tmpdir(), "opencode")`. Never the configured `root`: the rewrite
	 * replaces what core told the model, not what this plugin was configured with.
	 */
	readonly defaultRoot: string;
	readonly resolveLayout: (sessionID: string) => Promise<SessionLayout>;
	readonly logger: Logger;
	readonly state: InstructionState;
	readonly mkdir?: (dir: string, options: MkdirOptions) => Promise<unknown>;
}

/** The mutable `session.context` event fields the adapter reads and writes. */
export interface ContextEvent {
	readonly sessionID: string;
	readonly system: InstructionPart[];
}

const environmentSourceKey = "core/environment";
const leftContinuation = /[A-Za-z0-9._~\-/\\]/;
const rightContinuation = /[A-Za-z0-9_~\-\\]/;

interface InstructionEntry {
	readonly key: string | undefined;
	readonly text: string;
}

interface RewriteOutcome {
	readonly changed: boolean;
	readonly warning: "missing-source" | "replacement-miss" | undefined;
}

/**
 * Rewrites the `core/environment` part in place so it points at `sessionDir`. Returns whether anything changed.
 * Idempotence is checked across all text parts first, so a repeated call never appends a second fallback part.
 */
export function rewriteInstructions(
	parts: InstructionPart[],
	defaultRoot: string,
	sessionDir: string,
): boolean {
	return rewriteParts(parts, defaultRoot, sessionDir).changed;
}

/** Context hook adapter: create the session directory, then rewrite instructions unless enrichment is disabled. */
export async function applyInstructions(
	event: ContextEvent,
	deps: InstructionDeps,
): Promise<void> {
	const sessionID = event.sessionID;
	const { state } = deps;
	if (state.enrichmentDisabled.has(sessionID)) return;

	let layout: SessionLayout;
	try {
		layout = await deps.resolveLayout(sessionID);
	} catch {
		// A transient lookup failure is retried on the next call and must not disable this session.
		return;
	}

	const { mkdir = defaultMkdir } = deps;
	let pending = state.mkdirCache.get(sessionID);
	if (pending === undefined) {
		pending = Promise.resolve()
			.then(() => mkdir(layout.sessionDir, { recursive: true, mode: 0o700 }))
			.then(() => layout.sessionDir);
		state.mkdirCache.set(sessionID, pending);
	}

	let sessionDir: string;
	try {
		sessionDir = await pending;
	} catch (error) {
		state.enrichmentDisabled.add(sessionID);
		warnOnce(
			state,
			"mkdir",
			deps.logger,
			"could not create scratch directory for session %s",
			sessionID,
			error,
		);
		return;
	}

	const outcome = rewriteParts(event.system, deps.defaultRoot, sessionDir);
	if (outcome.warning !== undefined) {
		const message =
			outcome.warning === "missing-source"
				? "core/environment instruction part not found; appended a scratch-directory hint for %s"
				: "default scratch path not found in core/environment instructions; appended a scratch-directory hint for %s";
		warnOnce(state, outcome.warning, deps.logger, message, sessionID);
	}
}

function rewriteParts(
	parts: InstructionPart[],
	defaultRoot: string,
	sessionDir: string,
): RewriteOutcome {
	if (defaultRoot === "") return { changed: false, warning: undefined };

	for (const part of parts) {
		if (part.type === "text" && part.text.includes(sessionDir)) {
			return { changed: false, warning: undefined };
		}
	}

	const source = parts.find(isEnvironmentPart);
	if (source !== undefined) {
		const rewritten = replaceRoot(source.text, defaultRoot, sessionDir);
		if (rewritten.replaced) {
			source.text = rewritten.text;
			return { changed: true, warning: undefined };
		}
		parts.push(fallbackPart(sessionDir));
		return { changed: true, warning: "replacement-miss" };
	}

	parts.push(fallbackPart(sessionDir));
	return { changed: true, warning: "missing-source" };
}

/** Narrows `metadata.experimental.instructions` to the `{ key?, text }` entries core attaches. */
function instructionsEntries(
	metadata: Record<string, unknown> | undefined,
): InstructionEntry[] | undefined {
	if (metadata === undefined) return undefined;
	const experimental = metadata.experimental;
	if (typeof experimental !== "object" || experimental === null)
		return undefined;
	const instructions = (experimental as Record<string, unknown>).instructions;
	if (!Array.isArray(instructions)) return undefined;

	const entries: InstructionEntry[] = [];
	for (const value of instructions) {
		if (typeof value !== "object" || value === null) continue;
		const record = value as Record<string, unknown>;
		if (typeof record.text !== "string") continue;
		if (record.key !== undefined && typeof record.key !== "string") continue;
		entries.push({
			key: typeof record.key === "string" ? record.key : undefined,
			text: record.text,
		});
	}
	return entries;
}

/**
 * True when a part carries the `core/environment` source. A key wins even when the metadata text is stale, because
 * core does not update that copy when a hook edits `text`; without a key the entry is matched to its own part text.
 * Core concatenates several instruction sources into one part, so selection is by entry, not by part text.
 */
function isEnvironmentPart(part: InstructionPart): boolean {
	if (part.type !== "text") return false;
	const entries = instructionsEntries(part.metadata);
	if (entries === undefined) return false;
	return entries.some(
		(entry) =>
			entry.key === environmentSourceKey ||
			(entry.key === undefined && entry.text === part.text),
	);
}

/** Replaces stand-alone occurrences of `defaultRoot`; paths that extend it on either side are preserved. */
function replaceRoot(
	text: string,
	defaultRoot: string,
	sessionDir: string,
): { text: string; replaced: boolean } {
	if (defaultRoot === "") return { text, replaced: false };

	let result = "";
	let from = 0;
	let replaced = false;

	while (true) {
		const index = text.indexOf(defaultRoot, from);
		if (index === -1) break;
		const after = index + defaultRoot.length;
		const before = index === 0 ? undefined : text[index - 1];

		if (isLeftBoundary(before) && isRightBoundary(text, after)) {
			result += text.slice(from, index) + sessionDir;
			replaced = true;
		} else {
			result += text.slice(from, after);
		}
		from = after;
	}

	return replaced
		? { text: result + text.slice(from), replaced: true }
		: { text, replaced: false };
}

/** The match must not continue a path segment on its left. */
function isLeftBoundary(before: string | undefined): boolean {
	return before === undefined || !leftContinuation.test(before);
}

/**
 * The match may end the path token, including at a trailing separator. Segment characters block the match, and a dot
 * only blocks when it starts a longer name (`opencode.json`), not when it is sentence punctuation (`opencode.`).
 */
function isRightBoundary(text: string, after: number): boolean {
	if (after >= text.length) return true;
	const following = text[after] as string;
	if (following === "/" || following === "\\") return true;
	if (following === ".") {
		const next = text[after + 1];
		return next === undefined || !leftContinuation.test(next);
	}
	return !rightContinuation.test(following);
}

/** The stable fallback part appended when the source or the default path cannot be found. */
function fallbackPart(sessionDir: string): InstructionPart {
	return {
		type: "text",
		text: `Write scratch files for this session under ${sessionDir}.`,
	};
}

function defaultMkdir(dir: string, options: MkdirOptions): Promise<unknown> {
	return fsMkdir(dir, options);
}
