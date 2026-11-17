/**
 * Logging contract and once-per-instance warning deduplication.
 *
 * `index.ts` injects a `Logger` (console by default) into the modules. `WarnState` is created per plugin
 * instance, so several instances serving the same process do not suppress each other's warnings.
 */
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
