/**
 * Covers plugin wiring from README "Configuration", "Model instructions", "Enforcement", "Cleanup", and "Session
 * lifecycle": option parsing and defaults, hook and event registration, per-session memoization, move invalidation,
 * enforcement disablement, cleanup disposal, and the absence of a shell hook.
 *
 * Does not cover the pure logic in the other suites or behavior against a real server (`test/live/`). Every test uses
 * a fake context; filesystem tests use a fresh temporary root and never write to the production default scratch root.
 */
import assert from "node:assert/strict";
import { lstat, mkdir, realpath, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { format } from "node:util";
import type { PluginOptions } from "@opencode/plugin";
import {
	createPlugin,
	createSessionResolver,
	type PluginRuntime,
	parseOptions,
	sweepIntervalMs,
} from "../src/index.ts";
import { resolveLayout } from "../src/layout.ts";
import type { Logger } from "../src/logging.ts";
import {
	environmentText,
	makeEnvironmentPart,
} from "./fixtures/environment-part.ts";
import {
	createFakeContext,
	type FakeContext,
	type FakeSession,
} from "./helpers/fake-context.ts";
import { makeTmpRoot } from "./helpers/tmp-root.ts";

interface Harness {
	readonly fake: FakeContext;
	readonly cleanup: () => Promise<void>;
	readonly warnings: string[];
	readonly errors: string[];
}

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

async function setupPlugin(
	t: TestContext,
	options: PluginOptions,
	sessions: readonly FakeSession[] = [],
): Promise<Harness> {
	const fake = createFakeContext({ options, sessions });
	const { logger, warnings, errors } = makeLogger();
	const runtime: PluginRuntime = { logger };
	const setupCleanup = await createPlugin(runtime).setup(fake.context);
	const cleanup = async (): Promise<void> => {
		await setupCleanup?.();
	};
	t.after(cleanup);
	return { fake, cleanup, warnings, errors };
}

function fakeSession(
	sessionID: string,
	directory: string,
	projectID = "prj_test",
): FakeSession {
	return { sessionID, projectID, location: { directory } };
}

function permissionEvent(
	action: string,
	sessionID: string,
	resources: readonly string[],
	effect: "allow" | "deny" | "ask" = "allow",
): {
	sessionID: string;
	action: string;
	resources: string[];
	effect: "allow" | "deny" | "ask";
	message?: string;
} {
	return { sessionID, action, resources: [...resources], effect };
}

async function exists(target: string): Promise<boolean> {
	try {
		await lstat(target);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(
	check: () => Promise<boolean>,
	timeoutMs = 2000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await delay(5);
	}
	assert.fail("condition was not met before the timeout");
}

/** Patches global interval functions so setup never starts a real hourly timer. */
function makeTimerHarness(t: TestContext): {
	intervalMs: () => number | undefined;
	clearCalls: () => number;
	handle: unknown;
	cleared: () => unknown;
} {
	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	let intervalMs: number | undefined;
	let clearCalls = 0;
	let cleared: unknown;
	const fakeTimer = { unref: () => {} };

	globalThis.setInterval = ((_fn: () => void, ms: number) => {
		intervalMs = ms;
		return fakeTimer;
	}) as unknown as typeof setInterval;
	globalThis.clearInterval = ((timer: unknown) => {
		clearCalls++;
		cleared = timer;
	}) as unknown as typeof clearInterval;
	t.after(() => {
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
	});

	return {
		intervalMs: () => intervalMs,
		clearCalls: () => clearCalls,
		handle: fakeTimer,
		cleared: () => cleared,
	};
}

test("when_setup_runs_then_it_registers_the_context_hook_permission_hook_and_lifecycle_subscription", async (t) => {
	// Setup: default options narrowed to a temporary root with sweeping disabled.
	const root = await makeTmpRoot(t);

	// Execution: run setup once.
	const { fake } = await setupPlugin(t, { root, sweep: false });

	// Assertions: both hooks are registered once and the lifecycle stream is filtered and abortable.
	assert.deepEqual(fake.hookNames(), [
		"permission.evaluate",
		"session.context",
	]);
	assert.equal(fake.subscriptions.length, 1);
	assert.deepEqual(fake.subscriptions[0]?.types, [
		"session.deleted",
		"session.archived",
		"session.moved",
	]);
	assert.ok(fake.subscriptions[0]?.signal instanceof AbortSignal);
});

test("when_options_are_absent_then_the_readme_defaults_apply", async () => {
	// Setup: the default scratch root resolved the same way the parser resolves it.
	const defaultScratchRoot = path.join(tmpdir(), "opencode");
	const expectedRoot = await realpath(defaultScratchRoot).catch(() =>
		path.resolve(defaultScratchRoot),
	);

	// Execution: parse an empty options object.
	const subject = await parseOptions({});

	// Assertions: every documented default is present.
	assert.deepEqual(subject, {
		root: expectedRoot,
		enforce: "deny",
		allowExternal: true,
		sweep: true,
		maxAgeHours: 48,
		cleanupOnDelete: true,
		cleanupOnArchive: false,
	});
});

test("when_options_are_provided_then_they_override_the_defaults_and_the_root_is_normalized", async (t) => {
	// Setup: every option set away from its default plus a root spelled through `..`.
	const root = await makeTmpRoot(t);
	const unnormalizedRoot = `${root}${path.sep}..${path.sep}${path.basename(root)}`;

	// Execution: parse the overrides.
	const subject = await parseOptions({
		root: unnormalizedRoot,
		enforce: "ask",
		allowExternal: false,
		sweep: false,
		maxAgeHours: 2,
		cleanupOnDelete: false,
		cleanupOnArchive: true,
	});

	// Assertions: overrides win and the resolved root is the real temporary directory.
	assert.deepEqual(subject, {
		root,
		enforce: "ask",
		allowExternal: false,
		sweep: false,
		maxAgeHours: 2,
		cleanupOnDelete: false,
		cleanupOnArchive: true,
	});
});

test("when_an_option_is_invalid_then_parsing_rejects_it_naming_the_option_and_value", async (t) => {
	// Setup: one bad value per documented option.
	const root = await makeTmpRoot(t);
	const cases: Array<{
		options: PluginOptions;
		name: string;
		value: string;
	}> = [
		{ options: { root: "" }, name: "root", value: '""' },
		{ options: { root: 42 }, name: "root", value: "42" },
		{ options: { root, enforce: "allow" }, name: "enforce", value: '"allow"' },
		{
			options: { root, allowExternal: "yes" },
			name: "allowExternal",
			value: '"yes"',
		},
		{ options: { root, sweep: 1 }, name: "sweep", value: "1" },
		{ options: { root, maxAgeHours: 0 }, name: "maxAgeHours", value: "0" },
		{
			options: { root, maxAgeHours: Number.NaN },
			name: "maxAgeHours",
			value: "NaN",
		},
		{
			options: { root, cleanupOnDelete: null },
			name: "cleanupOnDelete",
			value: "null",
		},
		{
			options: { root, cleanupOnArchive: "no" },
			name: "cleanupOnArchive",
			value: '"no"',
		},
	];

	// Assertions: every case rejects with the option name and the offending value. Each promise is created and
	// awaited in turn so no rejection is left unhandled between iterations.
	for (const { options, name, value } of cases) {
		await assert.rejects(parseOptions(options), (error: Error) => {
			assert.match(error.message, new RegExp(name));
			assert.ok(
				error.message.includes(value),
				`expected ${error.message} to include ${value}`,
			);
			return true;
		});
	}
});

test("when_setup_receives_an_invalid_option_then_it_rejects_before_registering_anything", async (t) => {
	// Setup: a fake context with an unsupported enforcement mode.
	const root = await makeTmpRoot(t);
	const fake = createFakeContext({
		options: { root, enforce: "allow", sweep: false },
	});

	// Execution: run setup against the invalid configuration.
	const subject = Promise.resolve(createPlugin().setup(fake.context));

	// Assertions: setup rejects naming the option and leaves no hooks behind.
	await assert.rejects(subject, /enforce/);
	assert.deepEqual(fake.hookNames(), []);
});

test("when_defaults_apply_then_cross_session_writes_are_denied_and_external_checks_are_allowed", async (t) => {
	// Setup: one session under a temporary root, with every option left at its default except the root and sweep.
	const root = await makeTmpRoot(t);
	const session = fakeSession("ses_A", path.join(root, "workspace", "app"));
	const layout = resolveLayout(root, session);
	const { fake } = await setupPlugin(t, { root, sweep: false }, [session]);
	const foreign = path.join(root, "other_project", "ses_B", "notes.txt");

	// Execution: evaluate a foreign write and an external-directory check inside the root.
	const edit = permissionEvent("edit", "ses_A", [foreign]);
	const external = permissionEvent(
		"external_directory",
		"ses_A",
		[foreign],
		"ask",
	);
	await fake.firePermissionHook("evaluate", edit);
	await fake.firePermissionHook("evaluate", external);

	// Assertions: the default mode denies the write with the own directory named, while the external check is allowed.
	assert.equal(edit.effect, "deny");
	assert.match(edit.message ?? "", new RegExp(layout.sessionDir));
	assert.equal(external.effect, "allow");
});

test("when_enforce_is_off_then_edits_are_untouched_and_external_checks_still_apply", async (t) => {
	// Setup: enforcement disabled and external allowance left at its default.
	const root = await makeTmpRoot(t);
	const session = fakeSession("ses_A", path.join(root, "workspace", "app"));
	const { fake } = await setupPlugin(
		t,
		{ root, enforce: "off", sweep: false },
		[session],
	);

	// Execution: fire one foreign edit and one external check.
	const edit = permissionEvent("edit", "ses_A", [
		path.join(root, "other_project", "ses_B", "notes.txt"),
	]);
	const external = permissionEvent(
		"external_directory",
		"ses_A",
		[path.join(root, "loose.txt")],
		"ask",
	);
	await fake.firePermissionHook("evaluate", edit);
	await fake.firePermissionHook("evaluate", external);

	// Assertions: the edit is untouched and the external check is still allowed.
	assert.equal(edit.effect, "allow");
	assert.equal(edit.message, undefined);
	assert.equal(external.effect, "allow");
});

test("when_enforce_is_off_and_external_is_disallowed_then_no_permission_hook_is_registered", async (t) => {
	// Setup: both reasons to evaluate permissions are disabled.
	const root = await makeTmpRoot(t);

	// Execution: run setup.
	const { fake } = await setupPlugin(t, {
		root,
		enforce: "off",
		allowExternal: false,
		sweep: false,
	});

	// Assertions: only the context hook remains.
	assert.deepEqual(fake.hookNames(), ["session.context"]);
});

test("when_external_allowance_is_disabled_then_external_checks_are_untouched", async (t) => {
	// Setup: edits stay enforced while external directory checks are left to configured rules.
	const root = await makeTmpRoot(t);
	const session = fakeSession("ses_A", path.join(root, "workspace", "app"));
	const { fake } = await setupPlugin(
		t,
		{ root, allowExternal: false, sweep: false },
		[session],
	);
	const foreign = path.join(root, "other_project", "ses_B", "notes.txt");

	// Execution: fire an external check and a foreign write.
	const external = permissionEvent(
		"external_directory",
		"ses_A",
		[foreign],
		"ask",
	);
	const edit = permissionEvent("edit", "ses_A", [foreign]);
	await fake.firePermissionHook("evaluate", external);
	await fake.firePermissionHook("evaluate", edit);

	// Assertions: the external decision is untouched and the edit is still denied.
	assert.equal(external.effect, "ask");
	assert.equal(edit.effect, "deny");
});

test("when_the_context_hook_runs_twice_then_the_session_lookup_is_memoized", async (t) => {
	// Setup: one session and a temporary root.
	const root = await makeTmpRoot(t);
	const session = fakeSession("ses_A", path.join(root, "workspace", "app"));
	const layout = resolveLayout(root, session);
	const { fake } = await setupPlugin(t, { root, sweep: false }, [session]);
	const firstParts = [makeEnvironmentPart()];
	const secondParts = [makeEnvironmentPart()];

	// Execution: run the context hook for the same session twice.
	await fake.fireSessionHook("context", {
		sessionID: "ses_A",
		system: firstParts,
	});
	await fake.fireSessionHook("context", {
		sessionID: "ses_A",
		system: secondParts,
	});

	// Assertions: one lookup serves both calls and both rewrites point at the created directory.
	assert.deepEqual(fake.sessionGetCalls, ["ses_A"]);
	assert.equal(await exists(layout.sessionDir), true);
	assert.equal(firstParts[0]?.text.includes(layout.sessionDir), true);
	assert.equal(secondParts[0]?.text.includes(layout.sessionDir), true);
});

test("when_two_sessions_resolve_at_once_then_they_get_distinct_directories", async (t) => {
	// Setup: two sessions in different projects under one root.
	const root = await makeTmpRoot(t);
	const first = fakeSession("ses_A", path.join(root, "workspace", "first"));
	const second = fakeSession("ses_B", path.join(root, "workspace", "second"));
	const firstLayout = resolveLayout(root, first);
	const secondLayout = resolveLayout(root, second);
	const { fake } = await setupPlugin(t, { root, sweep: false }, [
		first,
		second,
	]);
	const firstParts = [makeEnvironmentPart()];
	const secondParts = [makeEnvironmentPart()];

	// Execution: fire both context hooks without awaiting the first.
	const subjects = Promise.all([
		fake.fireSessionHook("context", {
			sessionID: "ses_A",
			system: firstParts,
		}),
		fake.fireSessionHook("context", {
			sessionID: "ses_B",
			system: secondParts,
		}),
	]);
	await subjects;

	// Assertions: both sessions are looked up once and their directories do not collide.
	assert.deepEqual([...fake.sessionGetCalls].sort(), ["ses_A", "ses_B"]);
	assert.notEqual(firstLayout.sessionDir, secondLayout.sessionDir);
	assert.equal(firstParts[0]?.text.includes(firstLayout.sessionDir), true);
	assert.equal(secondParts[0]?.text.includes(secondLayout.sessionDir), true);
});

test("when_a_session_moves_then_the_memo_is_invalidated_and_the_next_lookup_uses_the_new_location", async (t) => {
	// Setup: a session whose directory was already created at the old location.
	const root = await makeTmpRoot(t);
	const oldLocation = path.join(root, "workspace", "old-name");
	const newLocation = path.join(root, "workspace", "new-name");
	const session = fakeSession("ses_A", oldLocation);
	const oldLayout = resolveLayout(root, session);
	const newLayout = resolveLayout(root, {
		...session,
		location: { directory: newLocation },
	});
	const { fake } = await setupPlugin(t, { root, sweep: false }, [session]);
	const firstParts = [makeEnvironmentPart()];
	await fake.fireSessionHook("context", {
		sessionID: "ses_A",
		system: firstParts,
	});

	// Execution: update the session, push the move event, and wait for the rename.
	fake.setSession({ ...session, location: { directory: newLocation } });
	fake.push({
		type: "session.moved",
		data: {
			sessionID: "ses_A",
			projectID: session.projectID,
			location: { directory: newLocation },
		},
	});
	await waitFor(() => exists(newLayout.sessionDir));
	// The handler clears the memo in a `finally` after the rename; let that microtask drain first.
	await delay(0);
	const secondParts = [makeEnvironmentPart()];
	await fake.fireSessionHook("context", {
		sessionID: "ses_A",
		system: secondParts,
	});

	// Assertions: the first lookup is not reused and the rewrite follows the renamed directory.
	assert.deepEqual(fake.sessionGetCalls, ["ses_A", "ses_A"]);
	assert.equal(firstParts[0]?.text.includes(oldLayout.sessionDir), true);
	assert.equal(secondParts[0]?.text.includes(newLayout.sessionDir), true);
	assert.equal(secondParts[0]?.text.includes(oldLayout.sessionDir), false);
});

test("when_a_disabled_session_moves_then_the_cached_failure_is_forgotten", async (t) => {
	// Setup: a regular file where the old project directory belongs, so the first mkdir fails.
	const root = await makeTmpRoot(t);
	const oldLocation = path.join(root, "workspace", "old-name");
	const newLocation = path.join(root, "workspace", "new-name");
	const session = fakeSession("ses_A", oldLocation);
	const oldLayout = resolveLayout(root, session);
	const newLayout = resolveLayout(root, {
		...session,
		location: { directory: newLocation },
	});
	await writeFile(oldLayout.projectDir, "occupied");
	const { fake, warnings } = await setupPlugin(t, { root, sweep: false }, [
		session,
	]);
	const failedParts = [makeEnvironmentPart()];
	await fake.fireSessionHook("context", {
		sessionID: "ses_A",
		system: failedParts,
	});
	const disabledEdit = permissionEvent("edit", "ses_A", [
		path.join(root, "other", "ses_B", "notes.txt"),
	]);
	await fake.firePermissionHook("evaluate", disabledEdit);

	// Execution: move the session, then retry the context hook until state clearing lets it enrich.
	fake.setSession({ ...session, location: { directory: newLocation } });
	fake.push({
		type: "session.moved",
		data: {
			sessionID: "ses_A",
			projectID: session.projectID,
			location: { directory: newLocation },
		},
	});
	await waitFor(async () => {
		const parts = [makeEnvironmentPart()];
		await fake.fireSessionHook("context", {
			sessionID: "ses_A",
			system: parts,
		});
		return parts[0]?.text.includes(newLayout.sessionDir) === true;
	});
	const enabledEdit = permissionEvent("edit", "ses_A", [
		path.join(root, "other", "ses_B", "notes.txt"),
	]);
	await fake.firePermissionHook("evaluate", enabledEdit);

	// Assertions: the failed state is cleared on the move, so enrichment and enforcement resume.
	assert.equal(failedParts[0]?.text, environmentText);
	assert.equal(disabledEdit.effect, "allow");
	assert.equal(await exists(newLayout.sessionDir), true);
	assert.deepEqual(fake.sessionGetCalls, ["ses_A", "ses_A"]);
	assert.equal(warnings.length, 1);
	assert.equal(enabledEdit.effect, "deny");
});

test("when_a_session_lookup_rejects_then_the_memo_entry_is_removed_and_the_next_call_retries", async (t) => {
	// Setup: a session the fake context does not know yet.
	const root = await makeTmpRoot(t);
	const session = fakeSession("ses_A", path.join(root, "workspace", "app"));
	const layout = resolveLayout(root, session);
	const { fake } = await setupPlugin(t, { root, sweep: false });
	const firstParts = [makeEnvironmentPart()];

	// Execution: fail the first lookup, add the session, then run the hook again.
	await fake.fireSessionHook("context", {
		sessionID: "ses_A",
		system: firstParts,
	});
	fake.setSession(session);
	const secondParts = [makeEnvironmentPart()];
	await fake.fireSessionHook("context", {
		sessionID: "ses_A",
		system: secondParts,
	});

	// Assertions: the failed lookup leaves the parts alone and does not poison the memo.
	assert.equal(firstParts[0]?.text, environmentText);
	assert.equal(secondParts[0]?.text.includes(layout.sessionDir), true);
	assert.deepEqual(fake.sessionGetCalls, ["ses_A", "ses_A"]);
});

test("when_the_scratch_directory_cannot_be_created_then_edits_are_untouched_and_the_warning_is_logged_once", async (t) => {
	// Setup: a root that is a regular file, so the session directory cannot be created.
	const root = await makeTmpRoot(t);
	const blockedRoot = path.join(root, "not-a-directory");
	await writeFile(blockedRoot, "occupied");
	const session = fakeSession("ses_A", path.join(root, "workspace", "app"));
	const { fake, warnings } = await setupPlugin(
		t,
		{ root: blockedRoot, sweep: false },
		[session],
	);

	// Execution: run the context hook twice, then attempt a foreign write.
	const firstParts = [makeEnvironmentPart()];
	const secondParts = [makeEnvironmentPart()];
	await fake.fireSessionHook("context", {
		sessionID: "ses_A",
		system: firstParts,
	});
	await fake.fireSessionHook("context", {
		sessionID: "ses_A",
		system: secondParts,
	});
	const edit = permissionEvent("edit", "ses_A", [
		path.join(blockedRoot, "project", "ses_B", "notes.txt"),
	]);
	await fake.firePermissionHook("evaluate", edit);

	// Assertions: instructions stay untouched, the session is disabled, and the warning is deduplicated.
	assert.equal(firstParts[0]?.text, environmentText);
	assert.equal(secondParts[0]?.text, environmentText);
	assert.deepEqual(fake.sessionGetCalls, ["ses_A"]);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /scratch directory/);
	assert.equal(edit.effect, "allow");
	assert.equal(edit.message, undefined);
});

test("when_cleanup_runs_then_registrations_are_disposed_the_subscription_aborts_and_the_timer_stops", async (t) => {
	// Setup: sweeping enabled so setup starts a timer, with the interval functions patched.
	const root = await makeTmpRoot(t);
	const timers = makeTimerHarness(t);
	const { fake, cleanup } = await setupPlugin(t, { root });
	const subscription = fake.subscriptions[0];
	assert.ok(subscription);

	// Execution: two concurrent cleanups must share the one release.
	await Promise.all([cleanup(), cleanup()]);

	// Assertions: hooks are disposed in reverse order, the stream is aborted, and the one interval was cleared.
	assert.deepEqual(fake.disposals, ["permission.evaluate", "session.context"]);
	assert.deepEqual(fake.hookNames(), []);
	assert.equal(subscription.signal?.aborted, true);
	assert.equal(timers.intervalMs(), sweepIntervalMs);
	assert.equal(timers.clearCalls(), 1);
	assert.equal(timers.cleared(), timers.handle);
});

test("when_setup_runs_with_sweeping_enabled_then_one_immediate_sweep_removes_stale_files", async (t) => {
	// Setup: a stale file inside an otherwise valid session tree.
	const root = await makeTmpRoot(t);
	makeTimerHarness(t);
	const stale = path.join(root, "example_project", "ses_A", "old.txt");
	await mkdir(path.dirname(stale), { recursive: true });
	await writeFile(stale, "old");
	const aged = new Date(Date.now() - 72 * 3_600_000);
	await utimes(stale, aged, aged);

	// Execution: setup with the default sweep option.
	await setupPlugin(t, { root });

	// Assertions: the immediate sweep removed the stale file.
	assert.equal(await exists(stale), false);
});

test("when_setup_runs_then_it_does_not_register_a_shell_hook_or_change_tmpdir", async (t) => {
	// Setup: a temporary root and the process TMPDIR before setup.
	const root = await makeTmpRoot(t);
	const tmpdirBefore = process.env.TMPDIR;

	// Execution: run setup.
	const { fake } = await setupPlugin(t, { root, sweep: false });

	// Assertions: no shell hook is registered and the environment is untouched.
	assert.deepEqual(fake.hookNames(), [
		"permission.evaluate",
		"session.context",
	]);
	assert.equal(
		fake.hookNames().some((name) => name.startsWith("shell.")),
		false,
	);
	assert.equal(process.env.TMPDIR, tmpdirBefore);
});

test("when_the_resolver_is_used_directly_then_concurrent_lookups_share_one_call_and_forget_drops_the_entry", async (t) => {
	// Setup: a resolver whose lookup is counted and resolved manually.
	const root = await makeTmpRoot(t);
	let lookups = 0;
	const resolver = createSessionResolver(root, async (sessionID) => {
		lookups++;
		return {
			projectID: "prj_direct",
			location: { directory: path.join(root, "workspace", sessionID) },
		};
	});

	// Execution: resolve the same session twice at once, forget it, and resolve again.
	const first = resolver.resolve("ses_A");
	const second = resolver.resolve("ses_A");
	const [firstLayout, secondLayout] = await Promise.all([first, second]);
	resolver.forget("ses_A");
	const thirdLayout = await resolver.resolve("ses_A");

	// Assertions: the shared promise means one lookup until the entry is forgotten.
	assert.equal(firstLayout, secondLayout);
	assert.notEqual(thirdLayout.sessionDir, undefined);
	assert.equal(lookups, 2);
});
