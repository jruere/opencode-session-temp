/**
 * Plugin wiring: option parsing, per-instance state, hook registration, and cleanup (README "Configuration").
 *
 * `parseOptions` validates `ctx.options` once and resolves the scratch root. `createSessionResolver` memoizes each
 * session's layout and shares concurrent lookups. `setup` binds the context rewrite, permission decisions, lifecycle
 * loop, and sweep timer to one plugin instance, and returns an idempotent cleanup that releases them.
 *
 * Deliberately absent: a shell hook and any environment mutation. A process-wide `TMPDIR` would make sessions share
 * one directory again, and core injects `OPENCODE_SESSION_ID` after `shell.create.before` runs.
 */
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Plugin, type PluginOptions } from "@opencode/plugin";
import { applyPermission } from "./enforce.ts";
import {
	applyInstructions,
	createInstructionState,
	forgetSession as forgetInstructionSession,
	type InstructionDeps,
	type InstructionState,
} from "./instructions.ts";
import { resolveLayout, type SessionLayout } from "./layout.ts";
import { subscribeLifecycle } from "./lifecycle.ts";
import type { Logger } from "./logging.ts";
import { startSweepTimer, sweepOnce } from "./sweep.ts";

type PluginContext = Plugin.Context;
type SessionID = Parameters<PluginContext["session"]["get"]>[0]["sessionID"];

/** The session fields the layout resolver needs. */
export interface SessionLookupResult {
	readonly projectID?: string | undefined;
	readonly location?: { readonly directory?: string | undefined } | undefined;
}

/** Core's per-session lookup, injected so tests can drive the resolver directly. */
export type SessionLookup = (sessionID: string) => Promise<SessionLookupResult>;

/** Memoized session layout resolution shared by the context and permission hooks. */
export interface SessionResolver {
	resolve(sessionID: string): Promise<SessionLayout>;
	forget(sessionID: string): void;
}

/**
 * Resolves each session once and shares the pending lookup. A rejected lookup is evicted so the next call retries,
 * and `forget` drops the entry after a move or delete.
 */
export function createSessionResolver(
	root: string,
	lookup: SessionLookup,
): SessionResolver {
	const cache = new Map<string, Promise<SessionLayout>>();

	return {
		resolve(sessionID) {
			const cached = cache.get(sessionID);
			if (cached !== undefined) return cached;

			const pending = Promise.resolve()
				.then(() => lookup(sessionID))
				.then((session) =>
					resolveLayout(root, layoutRequest(sessionID, session)),
				);
			cache.set(sessionID, pending);
			void pending.catch(() => {
				if (cache.get(sessionID) === pending) cache.delete(sessionID);
			});
			return pending;
		},
		forget(sessionID) {
			cache.delete(sessionID);
		},
	};
}

/** Validated plugin options with the defaults applied. */
export interface PluginConfig {
	readonly root: string;
	readonly enforce: "deny" | "ask" | "off";
	readonly allowExternal: boolean;
	readonly sweep: boolean;
	readonly maxAgeHours: number;
	readonly cleanupOnDelete: boolean;
	readonly cleanupOnArchive: boolean;
}

/** The hook interval from README "Cleanup": setup and then every 60 minutes. */
export const sweepIntervalMs = 60 * 60 * 1000;

/** Runtime seams for tests; production uses `console`, `Date.now`, and the OS temp root. */
export interface PluginRuntime {
	readonly logger?: Logger;
	readonly now?: () => number;
	readonly defaultRoot?: string;
}

/**
 * Parses and validates plugin options once per setup. Invalid values reject with an error that names the option and
 * the bad value. The resolved root is realpathed when it exists, so macOS `/tmp` and `/private/tmp` agree.
 */
export async function parseOptions(
	options: PluginOptions,
): Promise<PluginConfig> {
	const root = await realpathOrSelf(readRoot(options.root));

	return {
		root,
		enforce: readEnforce(options.enforce),
		allowExternal: readBoolean("allowExternal", options.allowExternal, true),
		sweep: readBoolean("sweep", options.sweep, true),
		maxAgeHours: readMaxAgeHours(options.maxAgeHours),
		cleanupOnDelete: readBoolean(
			"cleanupOnDelete",
			options.cleanupOnDelete,
			true,
		),
		cleanupOnArchive: readBoolean(
			"cleanupOnArchive",
			options.cleanupOnArchive,
			false,
		),
	};
}

/** Creates a plugin instance; the default export is the production instance. */
export function createPlugin(runtime: PluginRuntime = {}) {
	return Plugin.define({
		id: "opencode-session-temp",
		async setup(ctx) {
			const config = await parseOptions(ctx.options);
			const logger = runtime.logger ?? console;
			const now = runtime.now ?? Date.now;
			const defaultRoot =
				runtime.defaultRoot ?? path.join(tmpdir(), "opencode");
			const instructionState = createInstructionState();
			const resolver = createSessionResolver(config.root, async (sessionID) => {
				const session = await ctx.session.get({
					sessionID: sessionID as SessionID,
				});
				return session;
			});
			const forgetSession = (sessionID: string) => {
				resolver.forget(sessionID);
				forgetInstructionSession(instructionState, sessionID);
			};
			const instructionDeps: InstructionDeps = {
				defaultRoot,
				resolveLayout: (sessionID) => resolver.resolve(sessionID),
				logger,
				state: instructionState,
			};
			const registrations: Array<{ dispose: () => Promise<void> }> = [];
			const abortController = new AbortController();
			let lifecycleDone: Promise<void> | undefined;
			let stopSweep: (() => void) | undefined;
			let cleanupPromise: Promise<void> | undefined;

			const cleanup = (): Promise<void> => {
				cleanupPromise ??= (async () => {
					for (const registration of registrations.reverse()) {
						try {
							await registration.dispose();
						} catch (error) {
							logger.error(
								"scratch plugin could not dispose a registration: %s",
								error,
							);
						}
					}

					abortController.abort();

					if (lifecycleDone !== undefined) {
						try {
							await lifecycleDone;
						} catch (error) {
							logger.error(
								"scratch plugin could not stop the lifecycle loop: %s",
								error,
							);
						}
					}

					stopSweep?.();
				})();
				return cleanupPromise;
			};

			try {
				registrations.push(
					await ctx.session.hook("context", async (input) => {
						await applyInstructions(
							{ sessionID: input.sessionID, system: input.system },
							instructionDeps,
						);
					}),
				);

				if (config.enforce !== "off" || config.allowExternal) {
					registrations.push(
						await ctx.permission.hook("evaluate", async (event) => {
							await evaluatePermission(
								event,
								config,
								resolver,
								instructionState,
							);
						}),
					);
				}

				try {
					const events = ctx.event.subscribe({
						types: lifecycleEventTypes,
						signal: abortController.signal,
					});
					lifecycleDone = subscribeLifecycle(events, {
						root: config.root,
						cleanupOnDelete: config.cleanupOnDelete,
						cleanupOnArchive: config.cleanupOnArchive,
						logger,
						warnState: instructionState,
						forgetSession,
					}).catch((error: unknown) => {
						logger.error("scratch lifecycle loop failed: %s", error);
					});
				} catch (error) {
					logger.error("scratch lifecycle subscription failed: %s", error);
				}

				if (config.sweep) {
					const runSweep = () =>
						sweepOnce(config.root, {
							maxAgeHours: config.maxAgeHours,
							now: now(),
							logger,
						});
					stopSweep = startSweepTimer(runSweep, sweepIntervalMs, logger).stop;
					try {
						await runSweep();
					} catch (error) {
						logger.error("scratch sweep failed: %s", error);
					}
				}

				return cleanup;
			} catch (error) {
				await cleanup();
				throw error;
			}
		},
	});
}

export default createPlugin();

const lifecycleEventTypes = [
	"session.deleted",
	"session.archived",
	"session.moved",
] as const;

async function evaluatePermission(
	event: {
		readonly sessionID: string;
		readonly action: string;
		readonly resources: ReadonlyArray<string>;
		effect: "allow" | "deny" | "ask";
		message?: string;
	},
	config: PluginConfig,
	resolver: SessionResolver,
	instructionState: InstructionState,
): Promise<void> {
	if (event.action === "external_directory") {
		applyPermission(event, {
			root: config.root,
			ownDir: "",
			mode: config.enforce,
			allowExternal: config.allowExternal,
		});
		return;
	}

	if (event.action !== "edit" || config.enforce === "off") return;
	if (instructionState.enrichmentDisabled.has(event.sessionID)) return;

	let layout: SessionLayout;
	try {
		layout = await resolver.resolve(event.sessionID);
	} catch {
		// Leave the decision alone; the next request retries the lookup. The context hook reports the failure site.
		return;
	}

	applyPermission(event, {
		root: config.root,
		ownDir: layout.sessionDir,
		mode: config.enforce,
		allowExternal: config.allowExternal,
	});
}

function layoutRequest(
	sessionID: string,
	session: SessionLookupResult,
): {
	sessionID: string;
	projectID?: string;
	location?: { directory?: string };
} {
	const request: {
		sessionID: string;
		projectID?: string;
		location?: { directory?: string };
	} = { sessionID };

	if (session.projectID !== undefined) request.projectID = session.projectID;
	if (session.location !== undefined) {
		const location: { directory?: string } = {};
		if (session.location.directory !== undefined)
			location.directory = session.location.directory;
		request.location = location;
	}

	return request;
}

function readRoot(value: unknown): string {
	if (value === undefined) return path.resolve(path.join(tmpdir(), "opencode"));
	if (typeof value !== "string" || value.trim() === "")
		return invalid("root", value, "a non-empty path string");
	return path.resolve(value);
}

function readEnforce(value: unknown): PluginConfig["enforce"] {
	if (value === undefined) return "deny";
	if (value === "deny" || value === "ask" || value === "off") return value;
	return invalid("enforce", value, '"deny", "ask", or "off"');
}

function readBoolean(name: string, value: unknown, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	if (typeof value === "boolean") return value;
	return invalid(name, value, "a boolean");
}

function readMaxAgeHours(value: unknown): number {
	if (value === undefined) return 48;
	if (typeof value === "number" && Number.isFinite(value) && value > 0)
		return value;
	return invalid("maxAgeHours", value, "a positive finite number");
}

async function realpathOrSelf(root: string): Promise<string> {
	try {
		return await realpath(root);
	} catch {
		return root;
	}
}

function invalid(name: string, value: unknown, expected: string): never {
	throw new Error(
		`invalid plugin option "${name}": expected ${expected}, got ${describeValue(value)}`,
	);
}

function describeValue(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (value === null || typeof value === "number" || typeof value === "boolean")
		return String(value);

	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}
