/**
 * Probe plugin for the instruction-visibility live check.
 *
 * Loaded after the plugin under test, so its `context` hook sees the system parts as the first plugin left them.
 * It appends one JSON line per call to `options.output`; the live test reads the file. The probe does not mutate the
 * parts and does not depend on a model.
 */
import { appendFile } from "node:fs/promises";
import { Plugin } from "@opencode/plugin";

interface Observation {
	readonly sessionID: string;
	readonly system: ReadonlyArray<{
		readonly type: string;
		readonly text: string;
		readonly metadata?: Record<string, unknown>;
	}>;
}

export default Plugin.define({
	id: "session-temp-probe",
	async setup(ctx) {
		const output = ctx.options.output;
		if (typeof output !== "string" || output === "")
			throw new Error("probe plugin requires a string output option");

		await ctx.session.hook("context", async (input) => {
			const observation: Observation = {
				sessionID: input.sessionID,
				system: input.system.map((part) => ({
					type: part.type,
					text: part.text,
					...(part.metadata === undefined ? {} : { metadata: part.metadata }),
				})),
			};
			await appendFile(output, `${JSON.stringify(observation)}\n`);
		});
	},
});
