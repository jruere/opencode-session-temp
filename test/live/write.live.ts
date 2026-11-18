/**
 * Live check 2 from TESTING.md "Layer 3": two-session write.
 *
 * Drives two real sessions through `opencode serve` with a scripted OpenAI-compatible provider. The scripted replies
 * ask each session to write the same file name, then ask one session to overwrite the other session's file and to read
 * it. The check asserts separate directories, a denied cross-session write with the configured message, and a
 * successful cross-session read.
 *
 * Not covered here: a configured `edit` deny, shell redirections, and anything that needs a real model.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
	type StubReply,
	type StubRequest,
	startLiveServer,
} from "./helpers/live-server.ts";

interface ChatMessage {
	readonly role?: string;
	readonly content?: unknown;
}

test("when_two_sessions_write_the_same_name_then_their_paths_differ_and_a_cross_write_is_denied", async (t) => {
	// Setup: scripted state that resolves each session's own directory from the created layout.
	let scratchA: string | undefined;
	let scratchB: string | undefined;
	let sessionA = "";
	let sessionB = "";

	const server = await startLiveServer(t, {
		probe: false,
		respond: (request) => {
			if (lastMessageRole(request) === "tool") return { text: "done" };
			const text = lastUserText(request);
			if (text === undefined) return { text: "done" };
			const sessionID = headerValue(request, "x-opencode-session");

			if (text.includes("own-write")) {
				const scratch =
					sessionID === sessionA
						? scratchA
						: sessionID === sessionB
							? scratchB
							: undefined;
				assert.ok(
					scratch !== undefined,
					`no scratch directory for ${sessionID}`,
				);
				return write(
					path.join(scratch, "same-name.txt"),
					`written by ${sessionID}`,
				);
			}

			if (text.includes("foreign-write")) {
				assert.ok(scratchA !== undefined);
				return write(
					path.join(scratchA, "same-name.txt"),
					`hijacked by ${sessionID}`,
				);
			}

			if (text.includes("read-foreign")) {
				assert.ok(scratchA !== undefined);
				return {
					toolCalls: [
						{
							name: "read",
							arguments: { path: path.join(scratchA, "same-name.txt") },
						},
					],
				};
			}

			return { text: "done" };
		},
	});

	// Execution: the first session writes its own copy of the shared name.
	const first = await server.createSession("write check A");
	sessionA = first.id;
	scratchA = server.sessionDir(first);
	await server.prompt(first.id, "own-write");
	assert.equal(
		await readFile(path.join(scratchA, "same-name.txt"), "utf8"),
		`written by ${first.id}`,
	);

	// Execution: the second session writes the same file name in its own directory.
	const second = await server.createSession("write check B");
	sessionB = second.id;
	scratchB = server.sessionDir(second);
	await server.prompt(second.id, "own-write");
	assert.equal(
		await readFile(path.join(scratchB, "same-name.txt"), "utf8"),
		`written by ${second.id}`,
	);
	assert.notEqual(scratchA, scratchB);

	// Execution: the second session tries to overwrite the first session's file.
	const beforeForeign = server.stub.requests.length;
	await server.prompt(second.id, "foreign-write");
	const denial = toolResult(
		server.stub.requests.slice(beforeForeign),
		"belongs to another session",
	);

	// Assertions: the write was denied with an actionable message and the first session's file is intact.
	assert.ok(denial !== undefined, "the denied write never reached the model");
	assert.equal(denial.includes(second.id), true);
	assert.equal(denial.includes(path.join(scratchA, "same-name.txt")), true);
	assert.equal(
		await readFile(path.join(scratchA, "same-name.txt"), "utf8"),
		`written by ${first.id}`,
	);

	// Execution: the second session reads the first session's file.
	const beforeRead = server.stub.requests.length;
	await server.prompt(second.id, "read-foreign");
	const readResult = toolResult(
		server.stub.requests.slice(beforeRead),
		`written by ${first.id}`,
	);

	// Assertions: cross-session reads are allowed and return the other session's content.
	assert.ok(readResult !== undefined, "the cross-session read did not succeed");
});

function write(filePath: string, content: string): StubReply {
	return {
		toolCalls: [{ name: "write", arguments: { path: filePath, content } }],
	};
}

function lastMessageRole(request: StubRequest): string | undefined {
	const messages = request.body.messages;
	if (!Array.isArray(messages)) return undefined;
	const last = messages.at(-1) as ChatMessage | undefined;
	return last?.role;
}

/** The last user-authored text, or undefined when the request carries only tool results. */
function lastUserText(request: StubRequest): string | undefined {
	const messages = request.body.messages;
	if (!Array.isArray(messages)) return undefined;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as ChatMessage;
		if (message.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		if (Array.isArray(message.content)) {
			const text = message.content
				.map((part) =>
					typeof part === "object" &&
					part !== null &&
					"text" in part &&
					typeof part.text === "string"
						? part.text
						: "",
				)
				.join("");
			return text;
		}
		return "";
	}
	return undefined;
}

/** Finds a tool result body containing `needle` in the requests recorded after a prompt. */
function toolResult(
	requests: ReadonlyArray<StubRequest>,
	needle: string,
): string | undefined {
	for (const request of requests) {
		const messages = request.body.messages;
		if (!Array.isArray(messages)) continue;
		for (const message of messages as ChatMessage[]) {
			if (message.role !== "tool") continue;
			if (typeof message.content !== "string") continue;
			if (message.content.includes(needle)) return message.content;
		}
	}
	return undefined;
}

function headerValue(request: StubRequest, name: string): string {
	const value = request.headers[name];
	return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}
