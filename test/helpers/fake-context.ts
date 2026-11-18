/**
 * Fake OpenCode V2 plugin context for wiring tests.
 *
 * Implements only the surface the plugin uses: `location`, `options`, `session.get`, `session.hook`,
 * `permission.hook`, and `event.subscribe`. It records hook and subscription registrations and the order in which
 * registrations are disposed, returns disposable registrations, and lets a test fire a hook with a mutable event or
 * push a lifecycle event through the subscription stream.
 *
 * Not covered here: core's rule evaluation, provider dispatch, tools, and the real event transport. All casts to
 * `Plugin.Context` live in this module so no test needs one.
 */
import type { Plugin, PluginOptions } from "@opencode/plugin";

type Context = Plugin.Context;
type SessionInfo = Awaited<ReturnType<Context["session"]["get"]>>;
type Registration = Awaited<ReturnType<Context["permission"]["hook"]>>;
type Hook = (input: never) => unknown;

/** The session fields the plugin reads. */
export interface FakeSession {
	readonly sessionID: string;
	readonly projectID: string;
	readonly location: { readonly directory: string };
}

/** One recorded `event.subscribe` call. */
export interface FakeSubscription {
	readonly types: readonly string[] | undefined;
	readonly signal: AbortSignal | undefined;
}

/** A lifecycle event pushed through the subscription stream. */
export interface FakeEvent {
	readonly type: string;
	readonly data?: Record<string, unknown>;
	readonly location?: { readonly directory: string };
}

export interface FakeContextOptions {
	readonly location?: { readonly directory: string };
	readonly options?: PluginOptions;
	readonly sessions?: ReadonlyArray<FakeSession>;
}

export interface FakeContext {
	readonly context: Context;
	readonly sessionGetCalls: string[];
	readonly subscriptions: FakeSubscription[];
	readonly disposals: string[];
	hookNames(): string[];
	fireSessionHook(name: string, input: unknown): Promise<void>;
	firePermissionHook(name: string, input: unknown): Promise<void>;
	push(event: FakeEvent): void;
	setSession(session: FakeSession): void;
	disposeAll(): Promise<void>;
}

/** Runs the context's setup-level state machine. */
export function createFakeContext(input: FakeContextOptions = {}): FakeContext {
	const sessions = new Map(
		(input.sessions ?? []).map((session) => [session.sessionID, session]),
	);
	const sessionGetCalls: string[] = [];
	const subscriptions: FakeSubscription[] = [];
	const disposals: string[] = [];
	const hooks = new Map<string, Hook[]>();
	const registrations: Registration[] = [];

	const register = (name: string, callback: Hook): Promise<Registration> => {
		const registered = hooks.get(name) ?? [];
		registered.push(callback);
		hooks.set(name, registered);
		let disposed = false;
		const registration: Registration = {
			dispose: async () => {
				if (disposed) return;
				disposed = true;
				disposals.push(name);
				const index = registered.indexOf(callback);
				if (index !== -1) registered.splice(index, 1);
			},
		};
		registrations.push(registration);
		return Promise.resolve(registration);
	};

	const fire = async (name: string, event: unknown): Promise<void> => {
		for (const hook of hooks.get(name) ?? []) {
			await hook(event as never);
		}
	};

	const get: Context["session"]["get"] = async (request) => {
		sessionGetCalls.push(request.sessionID);
		const session = sessions.get(request.sessionID);
		if (session === undefined)
			throw new Error(`fake context has no session ${request.sessionID}`);
		return session as unknown as SessionInfo;
	};

	const sessionHook: Context["session"]["hook"] = async (name, callback) =>
		register(`session.${String(name)}`, callback as Hook);

	const permissionHook: Context["permission"]["hook"] = async (
		name,
		callback,
	) => register(`permission.${String(name)}`, callback as Hook);

	const stream = createEventStream<FakeEvent>();

	const subscribe: Context["event"]["subscribe"] = (options) => {
		subscriptions.push({ types: options?.types, signal: options?.signal });
		if (options?.signal?.aborted) stream.end();
		else
			options?.signal?.addEventListener("abort", () => stream.end(), {
				once: true,
			});
		return stream.iterable as AsyncIterable<never>;
	};

	const location = {
		directory: input.location?.directory ?? "/fake/location",
	} as unknown as Context["location"];
	const session = { get, hook: sessionHook } as unknown as Context["session"];
	const permission = {
		hook: permissionHook,
	} as unknown as Context["permission"];
	const event = { subscribe };
	const options = input.options ?? {};

	return {
		context: {
			location,
			options,
			session,
			permission,
			event,
		} as unknown as Context,
		sessionGetCalls,
		subscriptions,
		disposals,
		hookNames: () =>
			[...hooks.entries()]
				.filter(([, callbacks]) => callbacks.length > 0)
				.map(([name]) => name)
				.sort(),
		fireSessionHook: (name, hookInput) => fire(`session.${name}`, hookInput),
		firePermissionHook: (name, hookInput) =>
			fire(`permission.${name}`, hookInput),
		push: (lifecycleEvent) => stream.push(lifecycleEvent),
		setSession: (session) => {
			sessions.set(session.sessionID, session);
		},
		disposeAll: async () => {
			for (const registration of registrations.reverse())
				await registration.dispose();
			stream.end();
		},
	};
}

/** A single-consumer async iterable backed by a queue, so lifecycle tests never need timers. */
function createEventStream<T>(): {
	iterable: AsyncIterable<T>;
	push(value: T): void;
	end(): void;
} {
	const queue: T[] = [];
	let closed = false;
	let wake: (() => void) | undefined;

	const settle = () => {
		const resolve = wake;
		wake = undefined;
		resolve?.();
	};

	const iterable: AsyncIterable<T> = {
		[Symbol.asyncIterator]: () => ({
			next: async (): Promise<IteratorResult<T>> => {
				while (queue.length === 0) {
					if (closed) return { done: true, value: undefined };
					await new Promise<void>((resolve) => {
						wake = resolve;
					});
				}
				return { done: false, value: queue.shift() as T };
			},
			return: async (): Promise<IteratorResult<T>> => {
				closed = true;
				settle();
				return { done: true, value: undefined };
			},
		}),
	};

	return {
		iterable,
		push: (value) => {
			if (closed) return;
			queue.push(value);
			settle();
		},
		end: () => {
			closed = true;
			settle();
		},
	};
}
