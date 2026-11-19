/**
 * Covers instruction rewriting from README "Model instructions": source selection, boundary-accurate replacement,
 * idempotence, stable fallbacks, the per-session mkdir cache, warning deduplication, and enrichment disablement.
 *
 * Generated cases check the rewrite over a whole input space: idempotence, the no-op contract, fallback stability,
 * non-text and metadata immutability, and the left/right boundary rule against a declarative oracle. Generated roots
 * are path-shaped: every character except a Windows drive colon is in `leftContinuation`, and the colon cannot precede
 * a nested occurrence because the root starts with the drive prefix. A nested occurrence is therefore always
 * left-blocked, which keeps the oracle equivalent to the scanner, which skips the interior of a rejected occurrence.
 *
 * Does not cover hook registration or per-instance state ownership (M6), permission decisions, or cleanup. The pure
 * rewrite never touches the filesystem; adapter tests inject resolvers and mkdir except for the one test that pins the
 * default mkdir against a real temporary root.
 */
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { format } from "node:util";
import fc from "fast-check";
import {
	applyInstructions,
	createInstructionState,
	forgetSession,
	type InstructionDeps,
	type InstructionPart,
	type InstructionState,
	type MkdirOptions,
	rewriteInstructions,
} from "../src/instructions.ts";
import type { SessionLayout } from "../src/layout.ts";
import type { Logger } from "../src/logging.ts";
import {
	defaultRoot,
	environmentText,
	makeEnvironmentPart,
} from "./fixtures/environment-part.ts";
import { makeTmpRoot } from "./helpers/tmp-root.ts";

/** A session directory lexical to the temp root but distinct from the default scratch root. */
const sessionDir = path.join(tmpdir(), "session-temp-tests", "ses_A");

function makeLogger(): { logger: Logger; warnings: string[] } {
	const warnings: string[] = [];
	const logger: Logger = {
		warn: (message, ...args) => warnings.push(format(message, ...args)),
		error: (message, ...args) => warnings.push(format(message, ...args)),
	};
	return { logger, warnings };
}

function layoutFor(dir: string): SessionLayout {
	return {
		projectSlug: "project",
		projectDir: path.dirname(dir),
		sessionDir: dir,
	};
}

function adapterDeps(options: {
	logger: Logger;
	state: InstructionState;
	resolveLayout?: (sessionID: string) => Promise<SessionLayout>;
	mkdir?: (dir: string, mkdirOptions: MkdirOptions) => Promise<unknown>;
}): InstructionDeps {
	return {
		defaultRoot,
		resolveLayout: options.resolveLayout ?? (async () => layoutFor(sessionDir)),
		logger: options.logger,
		state: options.state,
		mkdir: options.mkdir ?? (async () => {}),
	};
}

function appendedText(parts: InstructionPart[]): string {
	const last = parts.at(-1);
	assert.ok(last);
	return last.text;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

test("when_parts_contain_the_environment_source_then_only_that_part_is_rewritten", () => {
	// Setup: one environment part with the instructions metadata and one unrelated text part with the same path.
	const source = makeEnvironmentPart();
	const unrelated: InstructionPart = {
		type: "text",
		text: `A generic hint about ${defaultRoot}.`,
	};
	const parts: InstructionPart[] = [unrelated, source];

	// Execution: run the pure rewrite.
	const subject = rewriteInstructions(parts, defaultRoot, sessionDir);

	// Assertions: only the part named by the metadata is rewritten.
	assert.equal(subject, true);
	assert.equal(source.text.includes(sessionDir), true);
	assert.equal(source.text.includes(defaultRoot), false);
	assert.equal(unrelated.text, `A generic hint about ${defaultRoot}.`);
	assert.equal(parts.length, 2);
});

test("when_default_path_is_a_prefix_of_another_path_then_it_rewrites_only_the_exact_path", () => {
	// Setup: spellings where the default root is a strict part of a longer path token or ends a sentence.
	const cases = [
		{ text: `use ${defaultRoot} now`, expected: `use ${sessionDir} now` },
		{ text: `${defaultRoot}-other`, expected: `${defaultRoot}-other` },
		{ text: `${defaultRoot}_other`, expected: `${defaultRoot}_other` },
		{ text: `${defaultRoot}.json`, expected: `${defaultRoot}.json` },
		{ text: `/x${defaultRoot}`, expected: `/x${defaultRoot}` },
		{ text: `..${defaultRoot}`, expected: `..${defaultRoot}` },
		{ text: `${defaultRoot}/child`, expected: `${sessionDir}/child` },
		{ text: `${defaultRoot}.`, expected: `${sessionDir}.` },
		{ text: `(${defaultRoot})`, expected: `(${sessionDir})` },
	];

	// Execution: rewrite each spelling through a real environment part.
	const subjects = cases.map(({ text }) => {
		const source = makeEnvironmentPart(text);
		const parts: InstructionPart[] = [source];
		rewriteInstructions(parts, defaultRoot, sessionDir);
		return { source, parts };
	});

	// Assertions: only stand-alone occurrences are replaced; misses fall back instead of corrupting the path.
	for (const [index, subject] of subjects.entries()) {
		const expected = cases[index]?.expected;
		assert.ok(expected !== undefined);
		assert.equal(subject.source.text, expected);
		assert.equal(subject.parts.length, expected.includes(sessionDir) ? 1 : 2);
	}
});

test("when_a_part_already_contains_the_session_directory_then_the_rewrite_is_a_no_op", () => {
	// Setup: a part already carrying the session directory.
	const source = makeEnvironmentPart(`Files live under ${sessionDir}.`);
	const parts: InstructionPart[] = [source];
	const before = source.text;

	// Execution: run the pure rewrite twice.
	const first = rewriteInstructions(parts, defaultRoot, sessionDir);
	const second = rewriteInstructions(parts, defaultRoot, sessionDir);

	// Assertions: both calls report no change and the text is untouched.
	assert.equal(first, false);
	assert.equal(second, false);
	assert.equal(source.text, before);
});

test("when_rewrite_runs_on_equal_inputs_then_the_text_is_byte_identical", () => {
	// Setup: two independent arrays with the same environment source.
	const firstParts: InstructionPart[] = [makeEnvironmentPart()];
	const secondParts: InstructionPart[] = [makeEnvironmentPart()];

	// Execution: rewrite both arrays.
	assert.equal(rewriteInstructions(firstParts, defaultRoot, sessionDir), true);
	assert.equal(rewriteInstructions(secondParts, defaultRoot, sessionDir), true);

	// Assertions: the same inputs produce byte-identical output.
	assert.equal(firstParts[0]?.text, secondParts[0]?.text);
});

test("when_the_source_part_is_missing_then_a_stable_fallback_part_is_appended", () => {
	// Setup: text parts with no environment instructions metadata.
	const parts: InstructionPart[] = [
		{ type: "text", text: "Nothing here names the environment." },
	];

	// Execution: run the pure rewrite on this array and on a fresh copy.
	const subject = rewriteInstructions(parts, defaultRoot, sessionDir);
	const fresh: InstructionPart[] = [
		{ type: "text", text: "Nothing here names the environment." },
	];
	rewriteInstructions(fresh, defaultRoot, sessionDir);

	// Assertions: one stable part naming the session directory is appended each time.
	assert.equal(subject, true);
	assert.equal(parts.length, 2);
	assert.equal(appendedText(parts), appendedText(fresh));
	assert.equal(appendedText(parts).includes(sessionDir), true);
});

test("when_the_default_root_is_absent_from_the_source_then_the_fallback_is_appended", () => {
	// Setup: an environment source whose text does not mention the default root.
	const source = makeEnvironmentPart("A short environment note.");
	const parts: InstructionPart[] = [source];

	// Execution: run the pure rewrite.
	const subject = rewriteInstructions(parts, defaultRoot, sessionDir);

	// Assertions: the original text stays put and a fallback part is appended.
	assert.equal(subject, true);
	assert.equal(source.text, "A short environment note.");
	assert.equal(parts.length, 2);
	assert.equal(appendedText(parts).includes(sessionDir), true);
});

test("when_a_fallback_was_appended_then_a_second_call_does_not_append_again", () => {
	// Setup: a part with no environment source.
	const parts: InstructionPart[] = [{ type: "text", text: "Plain." }];
	rewriteInstructions(parts, defaultRoot, sessionDir);
	const afterFirst = parts.map((part) => part.text);

	// Execution: run the rewrite again.
	const subject = rewriteInstructions(parts, defaultRoot, sessionDir);

	// Assertions: idempotence sees the appended session directory and returns false.
	assert.equal(subject, false);
	assert.deepEqual(
		parts.map((part) => part.text),
		afterFirst,
	);
});

test("when_the_environment_part_is_rewritten_then_its_metadata_is_unchanged", () => {
	// Setup: an environment part whose metadata holds the instructions copy.
	const source = makeEnvironmentPart();
	const metadataBefore = structuredClone(source.metadata);
	const metadataRef = source.metadata;
	const parts: InstructionPart[] = [source];

	// Execution: run the pure rewrite.
	rewriteInstructions(parts, defaultRoot, sessionDir);

	// Assertions: the metadata copy is neither rewritten nor replaced.
	assert.deepEqual(source.metadata, metadataBefore);
	assert.equal(source.metadata, metadataRef);
});

test("when_a_part_is_not_text_then_it_is_left_untouched", () => {
	// Setup: a non-text part carrying the default root beside a real environment source.
	const nonText: InstructionPart = {
		type: "media",
		text: defaultRoot,
	};
	const parts: InstructionPart[] = [nonText, makeEnvironmentPart()];

	// Execution: run the pure rewrite.
	rewriteInstructions(parts, defaultRoot, sessionDir);

	// Assertions: the non-text part is not considered for rewriting.
	assert.equal(nonText.text, defaultRoot);
});

test("when_the_source_key_is_present_then_stale_metadata_text_still_selects_the_part", () => {
	// Setup: core does not update the metadata copy when a hook edits text, so the key must win.
	const source: InstructionPart = {
		type: "text",
		text: environmentText,
		metadata: {
			experimental: {
				instructions: [{ key: "core/environment", text: "stale prose" }],
			},
		},
	};
	const parts: InstructionPart[] = [source];

	// Execution: run the pure rewrite.
	const subject = rewriteInstructions(parts, defaultRoot, sessionDir);

	// Assertions: the key selects the part even though the metadata text differs.
	assert.equal(subject, true);
	assert.equal(source.text.includes(sessionDir), true);
	assert.equal(parts.length, 1);
});

test("when_multiple_instruction_entries_are_listed_then_the_environment_entry_selects_the_part", () => {
	// Setup: core lists several sources on the same part and concatenates them into its text.
	const source: InstructionPart = {
		type: "text",
		text: `# Code Mode\n\nToday's date: 2026-01-01\n\n${environmentText}`,
		metadata: {
			experimental: {
				instructions: [
					{ key: "core/codemode", text: "# Code Mode" },
					{ key: "core/date", text: "Today's date: 2026-01-01" },
					{ key: "core/environment", text: environmentText },
				],
			},
		},
	};
	const parts: InstructionPart[] = [source];

	// Execution: run the pure rewrite.
	const subject = rewriteInstructions(parts, defaultRoot, sessionDir);

	// Assertions: the entry list selects the part and the preceding sources stay intact.
	assert.equal(subject, true);
	assert.equal(source.text.includes(sessionDir), true);
	assert.equal(source.text.includes(defaultRoot), false);
	assert.equal(source.text.startsWith("# Code Mode\n\nToday's date"), true);
	assert.equal(parts.length, 1);
});

test("when_the_source_key_names_another_source_then_the_part_is_not_selected", () => {
	// Setup: an instructions entry for a different source whose text happens to match the part.
	const source: InstructionPart = {
		type: "text",
		text: environmentText,
		metadata: {
			experimental: {
				instructions: [{ key: "core/other", text: environmentText }],
			},
		},
	};
	const parts: InstructionPart[] = [source];

	// Execution: run the pure rewrite.
	const subject = rewriteInstructions(parts, defaultRoot, sessionDir);

	// Assertions: the source text is untouched and the fallback is appended instead.
	assert.equal(subject, true);
	assert.equal(source.text, environmentText);
	assert.equal(parts.length, 2);
});

test("when_instructions_metadata_has_no_key_and_text_mismatches_then_the_part_is_not_selected", () => {
	// Setup: a keyless instructions entry whose text does not match its own part.
	const source: InstructionPart = {
		type: "text",
		text: environmentText,
		metadata: {
			experimental: {
				instructions: [{ text: "a different source" }],
			},
		},
	};
	const parts: InstructionPart[] = [source];

	// Execution: run the pure rewrite.
	const subject = rewriteInstructions(parts, defaultRoot, sessionDir);

	// Assertions: the mismatch leaves the part alone and falls back.
	assert.equal(subject, true);
	assert.equal(source.text, environmentText);
	assert.equal(parts.length, 2);
});

test("when_instructions_metadata_is_malformed_then_it_is_ignored_without_throwing", () => {
	// Setup: metadata values that fail each narrow step of the type guard.
	const parts: InstructionPart[] = [
		{
			type: "text",
			text: environmentText,
			metadata: { experimental: "nope" },
		},
		{
			type: "text",
			text: environmentText,
			metadata: { experimental: { instructions: [{ key: 42 }] } },
		},
		{
			type: "text",
			text: environmentText,
			metadata: { experimental: { instructions: null } },
		},
		{
			type: "text",
			text: environmentText,
			metadata: { experimental: { instructions: { key: "core/environment" } } },
		},
		{ type: "text", text: environmentText },
	];

	// Execution: run the pure rewrite.
	const subject = rewriteInstructions(parts, defaultRoot, sessionDir);

	// Assertions: nothing is selected and one fallback is appended.
	assert.equal(subject, true);
	assert.equal(parts.length, 6);
});

test("when_the_default_root_is_empty_then_the_rewrite_is_a_no_op", () => {
	// Setup: an environment source and an empty default root.
	const source = makeEnvironmentPart();
	const parts: InstructionPart[] = [source];

	// Execution: run the pure rewrite.
	const subject = rewriteInstructions(parts, "", sessionDir);

	// Assertions: the guard prevents an infinite scan and changes nothing.
	assert.equal(subject, false);
	assert.equal(source.text, environmentText);
	assert.equal(parts.length, 1);
});

test("when_context_hook_runs_twice_then_it_is_byte_identical", async () => {
	// Setup: an adapter with a resolver, a succeeding mkdir, and a real environment source.
	const { logger, warnings } = makeLogger();
	const state = createInstructionState();
	let mkdirCalls = 0;
	const deps = adapterDeps({
		logger,
		state,
		mkdir: async () => {
			mkdirCalls++;
		},
	});
	const source = makeEnvironmentPart();
	const parts: InstructionPart[] = [source];
	const event = { sessionID: "ses_A", system: parts };

	// Execution: run the adapter twice.
	await applyInstructions(event, deps);
	const afterFirst = parts.map((part) => part.text);
	await applyInstructions(event, deps);
	const subject = parts.map((part) => part.text);

	// Assertions: output is byte-identical, mkdir is cached, and no warning is emitted on the success path.
	assert.deepEqual(subject, afterFirst);
	assert.equal(parts.length, 1);
	assert.equal(source.text.includes(sessionDir), true);
	assert.equal(mkdirCalls, 1);
	assert.deepEqual(warnings, []);
});

test("when_a_source_part_is_missing_then_the_adapter_appends_and_warns_once", async () => {
	// Setup: an adapter and parts with no environment source.
	const { logger, warnings } = makeLogger();
	const state = createInstructionState();
	const deps = adapterDeps({ logger, state });
	const parts: InstructionPart[] = [{ type: "text", text: "Plain text." }];
	const event = { sessionID: "ses_A", system: parts };

	// Execution: run the adapter twice.
	await applyInstructions(event, deps);
	const afterFirst = parts.map((part) => part.text);
	await applyInstructions(event, deps);
	const subject = parts.map((part) => part.text);

	// Assertions: one stable fallback part and one warning, with byte-identical text on the second call.
	assert.equal(parts.length, 2);
	assert.equal(appendedText(parts).includes(sessionDir), true);
	assert.deepEqual(subject, afterFirst);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /core\/environment/);
});

test("when_two_sessions_miss_the_source_then_the_warning_is_logged_once", async () => {
	// Setup: one shared state and two sessions, each with its own parts and directory.
	const { logger, warnings } = makeLogger();
	const state = createInstructionState();
	const deps = adapterDeps({
		logger,
		state,
		resolveLayout: async (sessionID) =>
			layoutFor(path.join(tmpdir(), "session-temp-tests", sessionID)),
	});
	const first: InstructionPart[] = [{ type: "text", text: "Plain." }];
	const second: InstructionPart[] = [{ type: "text", text: "Plain." }];

	// Execution: run the adapter once per session.
	await applyInstructions({ sessionID: "ses_A", system: first }, deps);
	await applyInstructions({ sessionID: "ses_B", system: second }, deps);

	// Assertions: both sessions fall back and the warning kind is deduplicated across sessions.
	assert.equal(first.length, 2);
	assert.equal(second.length, 2);
	assert.equal(warnings.length, 1);
});

test("when_two_warning_kinds_occur_then_each_is_logged_once", async () => {
	// Setup: a missing source, a replacement miss, then another missing source.
	const { logger, warnings } = makeLogger();
	const state = createInstructionState();
	const deps = adapterDeps({ logger, state });

	// Execution: drive one session per warning site.
	await applyInstructions(
		{ sessionID: "ses_A", system: [{ type: "text", text: "Plain." }] },
		deps,
	);
	await applyInstructions(
		{ sessionID: "ses_B", system: [makeEnvironmentPart("No root mentioned.")] },
		deps,
	);
	await applyInstructions(
		{ sessionID: "ses_C", system: [{ type: "text", text: "Plain." }] },
		deps,
	);

	// Assertions: one warning per kind, in first-seen order.
	assert.equal(warnings.length, 2);
	assert.match(warnings[0] ?? "", /core\/environment/);
	assert.match(warnings[1] ?? "", /default scratch path/);
});

test("when_the_replacement_is_missing_then_the_adapter_warns_and_appends", async () => {
	// Setup: an environment source whose text does not mention the default root.
	const { logger, warnings } = makeLogger();
	const deps = adapterDeps({ logger, state: createInstructionState() });
	const source = makeEnvironmentPart("A short environment note.");
	const parts: InstructionPart[] = [source];

	// Execution: run the adapter.
	await applyInstructions({ sessionID: "ses_A", system: parts }, deps);

	// Assertions: the source is untouched, a fallback is appended, and the replacement miss is logged.
	assert.equal(source.text, "A short environment note.");
	assert.equal(parts.length, 2);
	assert.equal(appendedText(parts).includes(sessionDir), true);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /default scratch path/);
});

test("when_mkdir_fails_then_instructions_are_untouched_and_enrichment_is_disabled", async () => {
	// Setup: an adapter whose mkdir always fails and an environment source in the parts.
	const { logger, warnings } = makeLogger();
	const state = createInstructionState();
	let resolveCalls = 0;
	const deps = adapterDeps({
		logger,
		state,
		resolveLayout: async () => {
			resolveCalls++;
			return layoutFor(sessionDir);
		},
		mkdir: async () => {
			throw new Error("EACCES");
		},
	});
	const source = makeEnvironmentPart();
	const parts: InstructionPart[] = [source];
	const before = parts.map((part) => part.text);
	const event = { sessionID: "ses_A", system: parts };

	// Execution: run the adapter twice.
	await applyInstructions(event, deps);
	await applyInstructions(event, deps);

	// Assertions: the failure is cached, enrichment stays disabled, and the parts are left untouched.
	assert.deepEqual(
		parts.map((part) => part.text),
		before,
	);
	assert.equal(parts.length, 1);
	assert.equal(state.enrichmentDisabled.has("ses_A"), true);
	assert.equal(resolveCalls, 1);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /scratch directory/);
});

test("when_one_sessions_mkdir_fails_then_another_session_is_still_enriched", async () => {
	// Setup: two sessions with distinct directories, where only the first mkdir fails.
	const { logger } = makeLogger();
	const state = createInstructionState();
	const failingDir = path.join(tmpdir(), "session-temp-tests", "ses_failing");
	const workingDir = path.join(tmpdir(), "session-temp-tests", "ses_working");
	const deps = adapterDeps({
		logger,
		state,
		resolveLayout: async (sessionID) =>
			layoutFor(sessionID === "ses_failing" ? failingDir : workingDir),
		mkdir: async (dir) => {
			if (dir === failingDir) throw new Error("EACCES");
		},
	});
	const failingParts: InstructionPart[] = [makeEnvironmentPart()];
	const workingParts: InstructionPart[] = [makeEnvironmentPart()];

	// Execution: enrich both sessions.
	await applyInstructions(
		{ sessionID: "ses_failing", system: failingParts },
		deps,
	);
	await applyInstructions(
		{ sessionID: "ses_working", system: workingParts },
		deps,
	);

	// Assertions: the failing session is untouched and disabled; the working session is rewritten.
	assert.equal(failingParts.length, 1);
	assert.equal(failingParts[0]?.text, environmentText);
	assert.equal(state.enrichmentDisabled.has("ses_failing"), true);
	assert.equal(state.enrichmentDisabled.has("ses_working"), false);
	assert.equal(workingParts[0]?.text.includes(workingDir), true);
});

test("when_concurrent_calls_share_a_session_then_mkdir_runs_once", async () => {
	// Setup: two calls for one session, with mkdir held open until both have started.
	const { logger } = makeLogger();
	const state = createInstructionState();
	const gate = deferred();
	let mkdirCalls = 0;
	const deps = adapterDeps({
		logger,
		state,
		mkdir: async () => {
			mkdirCalls++;
			await gate.promise;
		},
	});

	// Execution: start both calls, release mkdir, then await them.
	const first = applyInstructions(
		{ sessionID: "ses_A", system: [makeEnvironmentPart()] },
		deps,
	);
	const second = applyInstructions(
		{ sessionID: "ses_A", system: [makeEnvironmentPart()] },
		deps,
	);
	await Promise.resolve();
	gate.resolve();
	await Promise.all([first, second]);

	// Assertions: the shared cached promise means only one mkdir runs.
	assert.equal(mkdirCalls, 1);
});

test("when_the_layout_resolver_rejects_then_a_later_call_retries", async () => {
	// Setup: the first layout lookup fails transiently and the second succeeds.
	const { logger } = makeLogger();
	const state = createInstructionState();
	let attempts = 0;
	const deps = adapterDeps({
		logger,
		state,
		resolveLayout: async () => {
			attempts++;
			if (attempts === 1) throw new Error("transient");
			return layoutFor(sessionDir);
		},
	});
	const source = makeEnvironmentPart();
	const parts: InstructionPart[] = [source];
	const event = { sessionID: "ses_A", system: parts };

	// Execution: run the adapter while the lookup fails, then again after it recovers.
	await applyInstructions(event, deps);
	const afterFailure = {
		text: source.text,
		length: parts.length,
		disabled: state.enrichmentDisabled.has("ses_A"),
		cached: state.mkdirCache.has("ses_A"),
	};
	await applyInstructions(event, deps);

	// Assertions: a resolver failure disables nothing and leaves no cache entry, so the retry enriches.
	assert.deepEqual(afterFailure, {
		text: environmentText,
		length: 1,
		disabled: false,
		cached: false,
	});
	assert.equal(source.text.includes(sessionDir), true);
	assert.equal(attempts, 2);
});

test("when_mkdir_succeeds_then_the_directory_is_created_recursively_with_mode_0700", async () => {
	// Setup: an adapter with a recording mkdir.
	const { logger } = makeLogger();
	let created: { dir: string; options: MkdirOptions } | undefined;
	const deps = adapterDeps({
		logger,
		state: createInstructionState(),
		mkdir: async (dir, options) => {
			created = { dir, options };
		},
	});

	// Execution: run the adapter.
	await applyInstructions(
		{ sessionID: "ses_A", system: [makeEnvironmentPart()] },
		deps,
	);

	// Assertions: the resolved session directory is created with the documented options.
	assert.deepEqual(created, {
		dir: sessionDir,
		options: { recursive: true, mode: 0o700 },
	});
});

test("when_the_default_mkdir_is_used_then_it_creates_the_directory_with_mode_0700", async (t) => {
	// Setup: a real temporary root and an adapter without a mkdir override.
	const root = await makeTmpRoot(t);
	const target = path.join(root, "project", "ses_A");
	const { logger } = makeLogger();
	const deps = {
		defaultRoot,
		resolveLayout: async () => layoutFor(target),
		logger,
		state: createInstructionState(),
	};
	const source = makeEnvironmentPart();
	const parts: InstructionPart[] = [source];

	// Execution: run the adapter against the real filesystem.
	await applyInstructions({ sessionID: "ses_A", system: parts }, deps);

	// Assertions: the session directory exists with mode 0700 and the text points at it.
	const stats = await stat(target);
	assert.equal(stats.isDirectory(), true);
	assert.equal(stats.mode & 0o777, 0o700);
	assert.equal(source.text.includes(target), true);
});

test("when_a_session_is_forgotten_then_the_next_call_retries_its_directory", async () => {
	// Setup: a session whose first mkdir fails, then a forget and a succeeding retry.
	const { logger } = makeLogger();
	const state = createInstructionState();
	let failing = true;
	let resolveCalls = 0;
	const deps = adapterDeps({
		logger,
		state,
		resolveLayout: async () => {
			resolveCalls++;
			return layoutFor(sessionDir);
		},
		mkdir: async () => {
			if (failing) throw new Error("EACCES");
		},
	});
	const source = makeEnvironmentPart();
	const parts: InstructionPart[] = [source];
	const event = { sessionID: "ses_A", system: parts };

	// Execution: fail once, clear the session, then retry successfully.
	await applyInstructions(event, deps);
	const afterFailure = {
		disabled: state.enrichmentDisabled.has("ses_A"),
		cached: state.mkdirCache.has("ses_A"),
	};
	forgetSession(state, "ses_A");
	const afterForget = {
		disabled: state.enrichmentDisabled.has("ses_A"),
		cached: state.mkdirCache.has("ses_A"),
	};
	failing = false;
	await applyInstructions(event, deps);

	// Assertions: forget clears both pieces of state so the retry can create and rewrite.
	assert.deepEqual(afterFailure, { disabled: true, cached: true });
	assert.deepEqual(afterForget, { disabled: false, cached: false });
	assert.equal(source.text.includes(sessionDir), true);
	assert.equal(resolveCalls, 2);
});

// ---------------------------------------------------------------------------
// Generated properties
// ---------------------------------------------------------------------------
// The table cases above pin documented examples. The properties below check the rewrite over a whole input space:
// idempotence, the no-op contract, fallback stability, non-text and metadata immutability, and the boundary rule
// against a declarative regex oracle. Arbitrary text supplies the characters that decide each boundary.

const rootPrefix = path.parse(path.resolve(".")).root;
const propertyRoot = path.join(rootPrefix, "session-temp-property-tests");

/** Safe, separator-free segments, so joining them always yields a strict descendant. */
const safeSegmentArb = fc.stringMatching(/^[A-Za-z0-9_-]{1,8}$/);

/** An absolute path-shaped string built with `path.sep`, including the filesystem root itself. */
const pathLikeArb = fc
	.array(safeSegmentArb, { minLength: 0, maxLength: 5 })
	.map((segments) => rootPrefix + segments.join(path.sep));

/** A distinctive generated session directory, long enough that arbitrary text never contains it. */
const sessionDirArb = fc
	.array(safeSegmentArb, { minLength: 0, maxLength: 3 })
	.map((segments) =>
		path.join(propertyRoot, "project", "ses_generated", ...segments),
	);

/** The default root, including the empty-string boundary case. */
const defaultRootArb = fc.oneof(
	{ weight: 8, arbitrary: pathLikeArb },
	{ weight: 1, arbitrary: fc.constant("") },
);

const instructionEntryArb = fc.record({
	key: fc.option(fc.string(), { nil: undefined }),
	text: fc.string(),
});

const metadataArb = fc.option(
	fc.record({
		experimental: fc.record({
			instructions: fc.array(instructionEntryArb, { maxLength: 3 }),
		}),
	}),
	{ nil: undefined },
);

/** Normalizes fast-check's null-prototype records so snapshots taken with `structuredClone` compare equal. */
function normalized<T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T> {
	return arb.map((value) => structuredClone(value));
}

/** A text part carrying a real `core/environment` entry, so the source-selection path is generated too. */
const environmentPartArb = fc.string().map((text) => ({
	type: "text",
	text,
	metadata: {
		experimental: {
			instructions: [{ key: "core/environment", text }],
		},
	},
}));

const partArb = normalized(
	fc.oneof(
		fc.record({
			type: fc.constantFrom("text", "media", "reasoning"),
			text: fc.string(),
			metadata: metadataArb,
		}),
		environmentPartArb,
	),
);

const partsArb = fc.array(partArb, { maxLength: 4 });

interface TextPiece {
	readonly kind:
		| "raw"
		| "bare"
		| "sentenceDot"
		| "jsonName"
		| "hyphenSuffix"
		| "underscoreSuffix"
		| "child"
		| "dotPrefix"
		| "dotDotPrefix"
		| "separatorPrefix"
		| "parenthesized"
		| "leadingSpace"
		| "trailingSpace"
		| "trailingSeparator"
		| "repeated"
		| "adjacent";
	readonly text: string;
}

const pieceArb: fc.Arbitrary<TextPiece> = fc.oneof(
	fc
		.string({ maxLength: 12 })
		.map((text): TextPiece => ({ kind: "raw", text })),
	fc
		.constantFrom(
			"bare",
			"sentenceDot",
			"jsonName",
			"hyphenSuffix",
			"underscoreSuffix",
			"child",
			"dotPrefix",
			"dotDotPrefix",
			"separatorPrefix",
			"parenthesized",
			"leadingSpace",
			"trailingSpace",
			"trailingSeparator",
			"repeated",
			"adjacent",
		)
		.map((kind): TextPiece => ({ kind, text: "" })),
);

/** Renders a piece around the generated root, covering both boundary sides and repeated occurrences. */
function renderPiece(piece: TextPiece, root: string): string {
	switch (piece.kind) {
		case "raw":
			return piece.text;
		case "bare":
			return root;
		case "sentenceDot":
			return `${root}.`;
		case "jsonName":
			return `${root}.json`;
		case "hyphenSuffix":
			return `${root}-other`;
		case "underscoreSuffix":
			return `${root}_other`;
		case "child":
			return `${root}${path.sep}child`;
		case "dotPrefix":
			return `.${root}`;
		case "dotDotPrefix":
			return `..${root}`;
		case "separatorPrefix":
			return `${path.sep}x${root}`;
		case "parenthesized":
			return `(${root})`;
		case "leadingSpace":
			return ` ${root}`;
		case "trailingSpace":
			return `${root} `;
		case "trailingSeparator":
			return `${root}${path.sep}`;
		case "repeated":
			return `${root} ${root}`;
		case "adjacent":
			return `${root}${root}`;
	}
}

const leftContinuationClass = String.raw`[A-Za-z0-9._~\-/\\]`;
const rightBoundaryLookahead = String.raw`(?=$|[/\\]|\.(?:[^A-Za-z0-9._~\-/\\]|$)|[^A-Za-z0-9._~\-\\])`;

/** A declarative statement of the boundary rule, independent of the scanner in `src/instructions.ts`. */
function expectedRewrittenText(
	text: string,
	root: string,
	sessionDir: string,
): string {
	const escapedRoot = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(
		`(?<!${leftContinuationClass})${escapedRoot}${rightBoundaryLookahead}`,
		"g",
	);
	return text.replace(pattern, () => sessionDir);
}

test("when_the_rewrite_returns_false_then_it_leaves_the_parts_unchanged", () => {
	// Setup: generated parts, roots including the empty string, session directories, and an input that already
	// contains the session directory.

	// Execution: rewrite each input once.
	fc.assert(
		fc.property(
			partsArb,
			defaultRootArb,
			sessionDirArb,
			fc.boolean(),
			(parts, root, dir, alreadyRewritten) => {
				const input: InstructionPart[] = alreadyRewritten
					? [{ type: "text", text: `Files live under ${dir}.` }, ...parts]
					: parts;
				const before = structuredClone(input);
				const subject = rewriteInstructions(input, root, dir);

				// Assertions: an already-enriched input is a no-op, and any false result leaves every part alone.
				if (alreadyRewritten) assert.equal(subject, false);
				if (!subject) assert.deepEqual(input, before);
			},
		),
	);
});

test("when_the_rewrite_runs_twice_then_it_returns_false_and_changes_nothing", () => {
	// Setup: generated parts and roots, with and without an environment source that names the root.

	// Execution: run the rewrite twice, snapshotting between calls.
	fc.assert(
		fc.property(
			partsArb,
			pathLikeArb,
			sessionDirArb,
			fc.boolean(),
			(parts, root, dir, includeSource) => {
				const input: InstructionPart[] = includeSource
					? [makeEnvironmentPart(`Scratch files live under ${root}.`), ...parts]
					: parts;
				rewriteInstructions(input, root, dir);
				const afterFirst = structuredClone(input);
				const subject = rewriteInstructions(input, root, dir);

				// Assertions: idempotence holds for an in-place rewrite and for an appended fallback alike.
				assert.equal(subject, false);
				assert.deepEqual(input, afterFirst);
			},
		),
	);
});

test("when_the_rewrite_appends_a_fallback_then_it_adds_one_part_derived_from_the_session_directory", () => {
	// Setup: generated parts that usually lack an environment source, plus generated roots and directories.

	// Execution: rewrite each array and compare with an independent run over a different array and root.
	fc.assert(
		fc.property(partsArb, defaultRootArb, sessionDirArb, (parts, root, dir) => {
			const before = structuredClone(parts);
			const subject = rewriteInstructions(parts, root, dir);
			const appended = parts.length - before.length;

			// Assertions: a false result never appends, and an append adds exactly one trailing text part.
			if (!subject) assert.equal(appended, 0);
			if (appended === 0) return;
			assert.equal(appended, 1);
			assert.deepEqual(parts.slice(0, before.length), before);
			const fallback = parts.at(-1);
			assert.equal(fallback?.type, "text");
			assert.equal(fallback?.text.includes(dir), true);

			// Assertions: the fallback text depends only on the session directory, not on the parts or the root.
			const independent: InstructionPart[] = [
				{ type: "text", text: "A different plain part." },
			];
			rewriteInstructions(independent, `${root}${path.sep}other`, dir);
			assert.deepEqual(independent.at(-1), fallback);
		}),
	);
});

test("when_the_source_is_rewritten_then_it_leaves_non-text_parts_and_metadata_untouched", () => {
	// Setup: non-text parts with arbitrary metadata, a source that starts with a stand-alone root, and a session
	// directory long enough that arbitrary text cannot already contain it.
	const nonTextPartsArb = fc.array(
		normalized(
			fc.record({
				type: fc.constantFrom("media", "reasoning"),
				text: fc.string(),
				metadata: metadataArb,
			}),
		),
		{ maxLength: 3 },
	);

	// Execution: rewrite each source in place.
	fc.assert(
		fc.property(
			nonTextPartsArb,
			pathLikeArb,
			fc.string({ maxLength: 40 }),
			sessionDirArb,
			(nonText, root, text, dir) => {
				const source = makeEnvironmentPart(`${root} ${text}`);
				const parts: InstructionPart[] = [...nonText, source];
				const before = structuredClone(nonText);
				const metadata = source.metadata;
				const metadataBefore = structuredClone(metadata);

				const subject = rewriteInstructions(parts, root, dir);

				// Assertions: the source is selected and rewritten, while every other part and the metadata copy
				// stay byte-identical and keep their identity.
				assert.equal(subject, true);
				assert.equal(source.text.includes(dir), true);
				assert.equal(parts.length, nonText.length + 1);
				assert.deepEqual(nonText, before);
				assert.equal(source.metadata, metadata);
				assert.deepEqual(source.metadata, metadataBefore);
			},
		),
	);
});

test("when_the_default_root_appears_then_it_replaces_only_stand-alone_occurrences", () => {
	// Setup: path-shaped roots, generated session directories, and text assembled from pieces that exercise both
	// boundaries, repeated occurrences, trailing separators, and the documented collision shapes.

	// Execution: rewrite a generated source and compare with a declarative boundary oracle.
	fc.assert(
		fc.property(
			pathLikeArb,
			fc.array(pieceArb, { maxLength: 8 }),
			sessionDirArb,
			(root, pieces, dir) => {
				const text = pieces.map((piece) => renderPiece(piece, root)).join("");
				const source = makeEnvironmentPart(text);
				const parts: InstructionPart[] = [source];
				const expected = expectedRewrittenText(text, root, dir);

				const subject = rewriteInstructions(parts, root, dir);

				// Assertions: the source text matches the oracle, and a miss appends exactly one fallback part.
				assert.equal(source.text, expected);
				assert.equal(subject, true);
				assert.equal(parts.length, expected === text ? 2 : 1);
			},
		),
	);
});
