/**
 * Live harness for checks against a real `opencode serve` process (TESTING.md "Layer 3").
 *
 * It creates an isolated HOME and scratch root, writes a project config that loads the plugin under test and the
 * probe plugin, starts a local OpenAI-compatible stub, then starts the server and waits for its API. Nothing here
 * needs a real model or network access.
 *
 * Not covered here: the manual checklist, a configured `edit` deny, and anything that needs the TUI.
 */
import { type ChildProcess, spawn } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { OpenCode } from "@opencode/client";
import { resolveLayout } from "../../../src/layout.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const probePluginDirectory = path.join(
	repositoryRoot,
	"test/live/fixtures/probe-plugin",
);

/** One request sent to the stub provider, recorded before the reply is chosen. */
export interface StubRequest {
	readonly headers: IncomingHttpHeaders;
	readonly body: Record<string, unknown>;
}

/** One tool call the stub asks the session to run. */
export interface StubToolCall {
	readonly name: string;
	readonly arguments: Record<string, unknown>;
}

/** A scripted model reply: final text or tool calls. */
export type StubReply =
	| { readonly text: string }
	| { readonly toolCalls: ReadonlyArray<StubToolCall> };

/** The local OpenAI-compatible provider the live sessions use. */
export interface StubProvider {
	readonly baseURL: string;
	readonly requests: StubRequest[];
	close(): Promise<void>;
}

/** One system-part snapshot written by the probe plugin. */
export interface ProbeObservation {
	readonly sessionID: string;
	readonly system: ReadonlyArray<{
		readonly type: string;
		readonly text: string;
		readonly metadata?: Record<string, unknown>;
	}>;
}

/** The session fields the live test needs from the API. */
export interface LiveSession {
	readonly id: string;
	readonly projectID: string;
	readonly location: { readonly directory: string };
}

export interface LiveServerOptions {
	readonly respond: (request: StubRequest) => StubReply | Promise<StubReply>;
	/** Load the probe plugin. Defaults to true; the write check does not need it. */
	readonly probe?: boolean;
}

export interface LiveServer {
	readonly baseUrl: string;
	readonly root: string;
	readonly projectDir: string;
	readonly movedDir: string;
	readonly probeOutput: string;
	readonly stub: StubProvider;
	readonly client: ReturnType<typeof OpenCode.make>;
	/** Server stderr/stdout, for asserting that the plugin did not warn. */
	logs(): string;
	createSession(title?: string): Promise<LiveSession>;
	prompt(sessionID: string, text: string): Promise<void>;
	moveSession(sessionID: string, directory: string): Promise<void>;
	observations(sessionID?: string): Promise<ProbeObservation[]>;
	waitForObservations(
		sessionID: string,
		count: number,
	): Promise<ProbeObservation[]>;
	sessionDir(session: LiveSession): string;
}

/** Starts the stub, the server, and the probe for one test. */
export async function startLiveServer(
	t: TestContext,
	options: LiveServerOptions,
): Promise<LiveServer> {
	const temporary = await realpath(
		await mkdtemp(path.join(tmpdir(), "opencode-session-temp-live-")),
	);
	const home = path.join(temporary, "home");
	const projectDir = path.join(temporary, "project");
	const movedDir = path.join(temporary, "moved");
	const root = path.join(temporary, "root");
	const probeOutput = path.join(temporary, "probe.jsonl");
	const configDir = path.join(projectDir, ".opencode");
	const movedConfigDir = path.join(movedDir, ".opencode");
	const password = "live-check";

	await Promise.all([
		mkdir(home, { recursive: true }),
		mkdir(projectDir, { recursive: true }),
		mkdir(movedDir, { recursive: true }),
		mkdir(root, { recursive: true }),
		mkdir(configDir, { recursive: true }),
		mkdir(movedConfigDir, { recursive: true }),
	]);

	const stub = await startStub(options.respond);
	const plugins: unknown[] = [
		{
			package: repositoryRoot,
			options: { root, sweep: false },
		},
	];
	if (options.probe !== false) {
		plugins.push({
			package: probePluginDirectory,
			options: { output: probeOutput },
		});
	}

	const config = JSON.stringify(
		{
			$schema: "https://opencode.ai/config.json",
			plugins,
			providers: {
				stub: {
					package: "@opencode/ai/providers/openai-compatible",
					name: "Stub",
					settings: { baseURL: stub.baseURL, apiKey: "live-check" },
					models: { stub: { name: "Stub" } },
				},
			},
			permissions: [
				{ action: "edit", resource: "*", effect: "allow" },
				{ action: "read", resource: "*", effect: "allow" },
			],
			lsp: false,
			update: "disable",
			compaction: { auto: false },
			snapshots: false,
		},
		null,
		2,
	);
	await Promise.all([
		writeFile(path.join(configDir, "opencode.json"), `${config}\n`, "utf8"),
		writeFile(
			path.join(movedConfigDir, "opencode.json"),
			`${config}\n`,
			"utf8",
		),
	]);

	const port = await freePort();
	const child = spawn(
		process.env.OPENCODE_BIN ?? "opencode",
		[
			"serve",
			"--hostname",
			"127.0.0.1",
			"--port",
			String(port),
			"--print-logs",
			"--log-level",
			"warn",
		],
		{
			cwd: projectDir,
			env: isolatedEnvironment(home, password),
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let logs = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		logs += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		logs += chunk.toString("utf8");
	});

	const baseUrl = `http://127.0.0.1:${port}`;
	const client = OpenCode.make({
		baseUrl,
		headers: { authorization: basicAuth(password) },
	});

	t.after(async () => {
		await stopProcess(child);
		await stub.close();
		await rm(temporary, { recursive: true, force: true });
	});

	await waitForServer(client, child, () => logs);

	return {
		baseUrl,
		root,
		projectDir,
		movedDir,
		probeOutput,
		stub,
		client,
		logs: () => logs,
		async createSession(title = "live check") {
			const session = await client.session.create({
				model: { providerID: "stub", id: "stub" },
				title,
			});
			return {
				id: session.id,
				projectID: session.projectID,
				location: { directory: session.location.directory },
			};
		},
		async prompt(sessionID, text) {
			await client.session.prompt({ sessionID, text });
			await client.experimental.session.wait({ sessionID });
		},
		async moveSession(sessionID, directory) {
			await client.session.move({ sessionID, directory });
		},
		async observations(sessionID) {
			return readObservations(probeOutput, sessionID);
		},
		async waitForObservations(sessionID, count) {
			try {
				return await waitFor(async () => {
					const found = await readObservations(probeOutput, sessionID);
					return found.length >= count ? found : undefined;
				}, `probe did not record ${count} context calls for ${sessionID}`);
			} catch (error) {
				const all = await readObservations(probeOutput);
				throw new Error(
					`${(error as Error).message}\nrecorded ${all.length} observations:\n${JSON.stringify(
						all.map((entry) => entry.sessionID),
					)}\nserver logs:\n${logs}`,
				);
			}
		},
		sessionDir(session) {
			return resolveLayout(root, {
				sessionID: session.id,
				projectID: session.projectID,
				location: session.location,
			}).sessionDir;
		},
	};
}

/** Polls until `probe` returns a value or the timeout expires. */
export async function waitFor<T>(
	probe: () => Promise<T | undefined> | T | undefined,
	message: string,
	timeoutMs = 15_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value !== undefined) return value;
		if (Date.now() >= deadline) throw new Error(message);
		await delay(50);
	}
}

/** Reads the probe's JSONL output, optionally filtered to one session. */
async function readObservations(
	file: string,
	sessionID?: string,
): Promise<ProbeObservation[]> {
	let content: string;
	try {
		content = await readFile(file, "utf8");
	} catch {
		return [];
	}

	const observations: ProbeObservation[] = [];
	for (const line of content.split("\n")) {
		if (line === "") continue;
		try {
			const parsed = JSON.parse(line) as ProbeObservation;
			if (sessionID === undefined || parsed.sessionID === sessionID)
				observations.push(parsed);
		} catch {
			// A half-written trailing line is retried by the caller.
		}
	}
	return observations;
}

/** Starts a minimal OpenAI-compatible chat-completions server. */
async function startStub(
	respond: (request: StubRequest) => StubReply | Promise<StubReply>,
): Promise<StubProvider> {
	const requests: StubRequest[] = [];
	let sequence = 0;
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(chunk as Buffer);
		const raw = Buffer.concat(chunks).toString("utf8");

		if (request.method === "GET" && request.url?.endsWith("/models")) {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					object: "list",
					data: [{ id: "stub", object: "model" }],
				}),
			);
			return;
		}

		if (!request.url?.endsWith("/chat/completions")) {
			response.writeHead(404, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: "not found" }));
			return;
		}

		let body: Record<string, unknown>;
		try {
			body = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			response.writeHead(400, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: "invalid json" }));
			return;
		}
		const recorded: StubRequest = { headers: request.headers, body };
		requests.push(recorded);

		let reply: StubReply;
		try {
			reply = await respond(recorded);
		} catch (error) {
			response.writeHead(500, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: String(error) }));
			return;
		}

		const id = `chatcmpl-live-${++sequence}`;
		const model = typeof body.model === "string" ? body.model : "stub";
		if (body.stream === false) {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(completion(id, model, reply, sequence)));
			return;
		}

		response.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		for (const chunk of streamChunks(id, model, reply, sequence)) {
			response.write(`data: ${JSON.stringify(chunk)}\n\n`);
		}
		response.end("data: [DONE]\n\n");
	});

	const port = await listen(server);
	return {
		baseURL: `http://127.0.0.1:${port}/v1`,
		requests,
		close: () => closeServer(server),
	};
}

function completion(
	id: string,
	model: string,
	reply: StubReply,
	sequence: number,
): Record<string, unknown> {
	const message =
		"toolCalls" in reply
			? {
					role: "assistant",
					content: null,
					tool_calls: reply.toolCalls.map((call, index) => ({
						id: `call_live_${sequence}_${index}`,
						type: "function",
						function: {
							name: call.name,
							arguments: JSON.stringify(call.arguments),
						},
					})),
				}
			: { role: "assistant", content: reply.text };
	return {
		id,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [
			{
				index: 0,
				message,
				finish_reason: "toolCalls" in reply ? "tool_calls" : "stop",
			},
		],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	};
}

function* streamChunks(
	id: string,
	model: string,
	reply: StubReply,
	sequence: number,
): Generator<Record<string, unknown>> {
	const base = {
		id,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model,
	};
	if ("toolCalls" in reply) {
		yield {
			...base,
			choices: [
				{
					index: 0,
					delta: {
						role: "assistant",
						tool_calls: reply.toolCalls.map((call, index) => ({
							index,
							id: `call_live_${sequence}_${index}`,
							type: "function",
							function: {
								name: call.name,
								arguments: JSON.stringify(call.arguments),
							},
						})),
					},
					finish_reason: null,
				},
			],
		};
		yield {
			...base,
			choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
		};
	} else {
		yield {
			...base,
			choices: [
				{
					index: 0,
					delta: { role: "assistant", content: reply.text },
					finish_reason: null,
				},
			],
		};
		yield {
			...base,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		};
	}
	yield {
		...base,
		choices: [],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	};
}

function isolatedEnvironment(
	home: string,
	password: string,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: home,
		XDG_CONFIG_HOME: path.join(home, ".config"),
		XDG_DATA_HOME: path.join(home, ".local/share"),
		XDG_STATE_HOME: path.join(home, ".local/state"),
		XDG_CACHE_HOME: path.join(home, ".cache"),
		OPENCODE_SERVER_PASSWORD: password,
	};
	delete env.OPENCODE_CONFIG;
	delete env.OPENCODE_CONFIG_CONTENT;
	return env;
}

function basicAuth(password: string): string {
	return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
}

async function waitForServer(
	client: ReturnType<typeof OpenCode.make>,
	child: ChildProcess,
	logs: () => string,
): Promise<void> {
	await waitFor(
		async () => {
			if (child.exitCode !== null)
				throw new Error(`opencode serve exited early:\n${logs()}`);
			try {
				await client.server.info();
				return true;
			} catch {
				return undefined;
			}
		},
		`opencode serve did not become ready:\n${logs()}`,
		20_000,
	);
}

async function freePort(): Promise<number> {
	const server = createServer();
	const port = await listen(server);
	await closeServer(server);
	return port;
}

function listen(server: Server): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string")
				reject(new Error("server did not bind to a TCP port"));
			else resolve(address.port);
		});
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => (error === undefined ? resolve() : reject(error)));
	});
}

async function stopProcess(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null) return;
	child.kill("SIGTERM");
	const exited = await Promise.race([
		new Promise<true>((resolve) => child.once("exit", () => resolve(true))),
		delay(5_000).then(() => false),
	]);
	if (!exited) child.kill("SIGKILL");
}

/** True when `dir` exists and is a directory; used by live assertions. */
export async function isDirectory(dir: string): Promise<boolean> {
	try {
		return (await stat(dir)).isDirectory();
	} catch {
		return false;
	}
}
