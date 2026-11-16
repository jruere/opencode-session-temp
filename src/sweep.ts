/**
 * Age-based cleanup and session lifecycle handlers (README "Cleanup" and "Session lifecycle").
 *
 * This milestone establishes only the shared logging surface: `Logger` is injected by `setup`, and warnings are
 * deduplicated once per plugin instance per kind. The sweep and lifecycle functions arrive with their own milestone.
 */
export type Logger = {
	warn: (message: string, ...args: unknown[]) => void;
	error: (message: string, ...args: unknown[]) => void;
};

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
