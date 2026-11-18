/**
 * Live check 1 from TESTING.md "Layer 3": instruction visibility.
 *
 * Starts a real `opencode serve` with the plugin under test followed by a probe plugin. The probe records the system
 * parts after the plugin rewrote them. The check asserts the session directory is present, the text is byte-identical
 * on the next call, and the path changes after a session move. It uses a scripted OpenAI-compatible stub, never a
 * language model.
 *
 * Not covered here: the two-session write check (`write.live.ts`), a configured `edit` deny (manual checklist), and
 * anything that needs the TUI.
 */
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	isDirectory,
	type ProbeObservation,
	startLiveServer,
	waitFor,
} from "./helpers/live-server.ts";

test("when_a_real_server_builds_the_prompt_then_the_session_directory_replaces_the_default_scratch_path", async (t) => {
	// Setup: a real server, the plugin under test, and a probe plugin loaded after it.
	const server = await startLiveServer(t, {
		respond: () => ({ text: "ok" }),
	});
	const session = await server.createSession("instructions live");

	// Execution: run one model turn so core builds the system parts.
	await server.prompt(session.id, "first");
	const observations = await server.waitForObservations(session.id, 1);
	const first = observations[0];
	assert.ok(first !== undefined);
	const scratch = server.sessionDir(session);
	const environment = environmentPart(first);

	// Assertions: the live core/environment source was rewritten in place, not duplicated by the fallback.
	assert.equal(environment.text.includes(scratch), true);
	assert.equal(hasStandaloneDefaultRoot(environment.text), false);
	assert.equal(first.system.some(isFallbackPart), false);
	assert.equal(server.logs().includes("instruction part not found"), false);
	assert.equal(server.logs().includes("default scratch path not found"), false);
	const directory = await stat(scratch);
	assert.equal(directory.isDirectory(), true);
	assert.equal(directory.mode & 0o777, 0o700);

	// Execution: build the next prompt for the same session.
	await server.prompt(session.id, "second");
	const afterSecond = await server.waitForObservations(session.id, 2);
	const second = afterSecond[1];
	assert.ok(second !== undefined);

	// Assertions: the system parts are byte-identical, so the prompt cache is not invalidated.
	assert.deepEqual(second.system, first.system);

	// Execution: move the session to another project directory.
	await server.moveSession(session.id, server.movedDir);
	const moved = await server.client.session.get({ sessionID: session.id });
	const movedScratch = server.sessionDir({
		id: moved.id,
		projectID: moved.projectID,
		location: moved.location,
	});
	await waitFor(async () => {
		const newExists = await isDirectory(movedScratch);
		const oldExists = await isDirectory(scratch);
		return newExists && !oldExists ? true : undefined;
	}, `scratch directory was not moved to ${movedScratch}`);
	await server.prompt(session.id, "after move");
	const afterMove = await server.waitForObservations(session.id, 3);
	const third = afterMove[2];
	assert.ok(third !== undefined);

	// Assertions: the instruction changed to the new directory and no longer names the old one.
	const movedEnvironment = environmentPart(third);
	assert.equal(movedEnvironment.text.includes(movedScratch), true);
	assert.equal(
		third.system.some((part) => part.text.includes(scratch)),
		false,
	);
});

function environmentPart(observation: ProbeObservation): {
	type: string;
	text: string;
	metadata?: Record<string, unknown>;
} {
	for (const part of observation.system) {
		const entries = instructionsEntries(part.metadata);
		if (entries.some((entry) => entry.key === "core/environment")) return part;
	}
	throw new Error(
		`no core/environment system part in the live prompt; core's instructions metadata changed:\n${JSON.stringify(
			observation.system.map((part) => part.metadata),
			null,
			2,
		)}`,
	);
}

function instructionsEntries(
	metadata: Record<string, unknown> | undefined,
): Array<{ key?: unknown }> {
	if (metadata === undefined) return [];
	const experimental = metadata.experimental;
	if (typeof experimental !== "object" || experimental === null) return [];
	const instructions = (experimental as Record<string, unknown>).instructions;
	if (!Array.isArray(instructions)) return [];
	return instructions.filter(
		(entry): entry is { key?: unknown } =>
			typeof entry === "object" && entry !== null,
	);
}

function isFallbackPart(part: { type: string; text: string }): boolean {
	return (
		part.type === "text" &&
		part.text.startsWith("Write scratch files for this session under ")
	);
}

/** True when the default root appears as a stand-alone path, using the plugin's boundary rules. */
function hasStandaloneDefaultRoot(text: string): boolean {
	const defaultRoot = path.join(tmpdir(), "opencode");
	let from = 0;
	while (from < text.length) {
		const index = text.indexOf(defaultRoot, from);
		if (index === -1) return false;
		const before = index === 0 ? undefined : text[index - 1];
		const after = index + defaultRoot.length;
		const following = text[after];
		const leftFree =
			before === undefined || !/[A-Za-z0-9._~\-/\\]/.test(before);
		const rightFree =
			following === undefined ||
			following === "/" ||
			following === "\\" ||
			(following === "."
				? text[after + 1] === undefined ||
					!/[A-Za-z0-9._~\-/\\]/.test(text[after + 1] as string)
				: !/[A-Za-z0-9_~\-\\]/.test(following));
		if (leftFree && rightFree) return true;
		from = after;
	}
	return false;
}
