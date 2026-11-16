/**
 * Minimal `core/environment` system part, pinned to the shape core uses with `@opencode/plugin` 2.2.6.
 *
 * The text is an excerpt, not core's prose: unit tests assert the rewrite, and the live check detects upstream
 * drift. `metadata.experimental.instructions` keeps a copy of the source text; it is not updated when a hook
 * edits `text`, and the plugin must not rewrite it.
 *
 * Not covered here: the full set of system parts core assembles around this one.
 */

import { tmpdir } from "node:os";
import path from "node:path";
import type { SystemPart } from "@opencode/ai/effect";

/** The default scratch root the plugin replaces. */
export const defaultRoot = path.join(tmpdir(), "opencode");

/** Minimal environment text that mentions the default root once. */
export const environmentText = `Write scratch files under ${defaultRoot} unless the task says otherwise.`;

/** Builds a system part with the instructions metadata core attaches. */
export function makeEnvironmentPart(
	text: string = environmentText,
): SystemPart {
	return {
		type: "text",
		text,
		metadata: {
			experimental: {
				instructions: { key: "core/environment", text },
			},
		},
	};
}
