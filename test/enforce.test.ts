/**
 * Covers write enforcement and external-directory auto-allow from README "Enforcement".
 *
 * Does not cover registration and per-session state, core's configured-deny precedence, or shell behavior. All
 * paths are lexical: they derive from a fresh temporary root but no project or session directory needs to exist.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import type { PermissionEvaluation } from "../src/enforce.ts";
import {
	applyPermission,
	evaluateEdit,
	evaluateExternal,
} from "../src/enforce.ts";
import { makeTmpRoot } from "./helpers/tmp-root.ts";

function expectedMessage(ownDir: string, resource: string): string {
	return `Session ${path.basename(ownDir)} may only write inside ${ownDir}; ${resource} belongs to another session.`;
}

test("when_resource_is_a_sibling_with_a_shared_prefix_then_it_is_treated_as_foreign", async (t) => {
	// Setup: two session directories whose names share a prefix.
	const root = await makeTmpRoot(t);
	const ownDir = path.join(root, "example_project", "ses_A");
	const resource = path.join(root, "example_project", "ses_AB", "notes.txt");

	// Execution: classify a write from the shorter-named session.
	const subject = evaluateEdit({
		root,
		ownDir,
		resources: [resource],
		mode: "deny",
	});

	// Assertions: the shared prefix must not make the sibling look local.
	assert.deepEqual(subject, {
		effect: "deny",
		message: expectedMessage(ownDir, resource),
	});
});

test("when_resource_is_inside_the_own_directory_then_it_is_untouched", async (t) => {
	// Setup: files directly in the own directory and in nested subdirectories.
	const root = await makeTmpRoot(t);
	const ownDir = path.join(root, "example_project", "ses_A");
	// Keep these spellings literal: path.join would strip the trailing separators before the code under test sees them.
	const resources = [
		ownDir,
		`${ownDir}${path.sep}`,
		`${ownDir}${path.sep}${path.sep}`,
		`${ownDir}${path.sep}.${path.sep}`,
		path.join(ownDir, "notes.txt"),
		path.join(ownDir, "nested", "deeper", "output.json"),
	];

	// Execution: classify writes from that session.
	const subject = evaluateEdit({ root, ownDir, resources, mode: "deny" });

	// Assertions: the own directory and everything below it is left alone.
	assert.equal(subject, undefined);
});

test("when_resource_is_outside_the_root_or_loose_under_it_then_it_is_untouched", async (t) => {
	// Setup: paths outside the root, directly under it, and directly under a project directory.
	const root = await makeTmpRoot(t);
	const ownDir = path.join(root, "example_project", "ses_A");
	const resources = [
		path.join(root, "loose.txt"),
		path.join(root, "example_project", "notes.txt"),
		path.join(root, "example_project", "shared", "notes.txt"),
		path.join(root, "..", "outside.txt"),
		path.join(process.cwd(), "notes.txt"),
	];

	// Execution: classify each path.
	const subjects = resources.map((resource) =>
		evaluateEdit({ root, ownDir, resources: [resource], mode: "deny" }),
	);

	// Assertions: neither the root itself nor non-session directories are enforced.
	assert.deepEqual(
		subjects,
		resources.map(() => undefined),
	);
});

test("when_resource_is_in_another_sessions_directory_then_the_configured_effect_is_returned", async (t) => {
	// Setup: a session in a different project.
	const root = await makeTmpRoot(t);
	const ownDir = path.join(root, "project_one", "ses_A");
	const resource = path.join(root, "project_two", "ses_B", "output.json");

	// Execution: classify the write under both configured modes.
	const subjects = (["deny", "ask"] as const).map((mode) =>
		evaluateEdit({ root, ownDir, resources: [resource], mode }),
	);

	// Assertions: each mode becomes the effect and the message stays identical.
	assert.deepEqual(
		subjects,
		(["deny", "ask"] as const).map((mode) => ({
			effect: mode,
			message: expectedMessage(ownDir, resource),
		})),
	);
});

test("when_there_are_multiple_resources_then_one_foreign_resource_is_enough_to_block", async (t) => {
	// Setup: an own file, a loose file, and a file in another session.
	const root = await makeTmpRoot(t);
	const ownDir = path.join(root, "example_project", "ses_A");
	const foreign = path.join(root, "example_project", "ses_B", "foreign.txt");
	const own = path.join(ownDir, "own.txt");
	const loose = path.join(root, "loose.txt");
	const subjects = [
		evaluateEdit({
			root,
			ownDir,
			resources: [own, loose, foreign],
			mode: "deny",
		}),
		evaluateEdit({
			root,
			ownDir,
			resources: [foreign, own, loose],
			mode: "deny",
		}),
	];

	// Assertions: the foreign resource determines the decision in either position.
	assert.deepEqual(
		subjects,
		subjects.map(() => ({
			effect: "deny",
			message: expectedMessage(ownDir, foreign),
		})),
	);
});

test("when_resource_uses_traversal_or_is_relative_then_it_is_normalized_before_classification", async (t) => {
	// Setup: traversal, a relative path, a nonexistent foreign path, and a traversal back to the root.
	const root = await makeTmpRoot(t);
	const ownDir = path.join(root, "example_project", "ses_A");
	const foreign = path.join(root, "example_project", "ses_B", "notes.txt");
	// Build `..` paths by concatenation: path.join would normalize them before evaluateEdit sees the input,
	// leaving the normalization branch untested.
	const cases: Array<{ resource: string; expected: string | undefined }> = [
		{
			resource: `${ownDir}${path.sep}..${path.sep}ses_B${path.sep}notes.txt`,
			expected: foreign,
		},
		{ resource: path.relative(process.cwd(), foreign), expected: foreign },
		{
			resource: path.join(
				root,
				"missing_project",
				"ses_C",
				"nested",
				"missing.txt",
			),
			expected: path.join(
				root,
				"missing_project",
				"ses_C",
				"nested",
				"missing.txt",
			),
		},
		{
			resource: `${ownDir}${path.sep}..${path.sep}..${path.sep}loose.txt`,
			expected: undefined,
		},
		{
			resource: `${ownDir}${path.sep}nested${path.sep}..${path.sep}notes.txt`,
			expected: undefined,
		},
	];

	// Execution: classify each normalized path.
	const subjects = cases.map(({ resource }) =>
		evaluateEdit({ root, ownDir, resources: [resource], mode: "deny" }),
	);

	// Assertions: lexical normalization decides, and nonexistent paths still classify.
	for (const [index, subject] of subjects.entries()) {
		const expected = cases[index]?.expected;
		if (expected === undefined) {
			assert.equal(subject, undefined);
		} else {
			assert.equal(subject?.effect, "deny");
			assert.equal(subject?.message, expectedMessage(ownDir, expected));
		}
	}
});

test("when_external_directory_is_inside_the_root_then_it_is_allowed_only_when_configured", async (t) => {
	// Setup: one resource inside the root and one outside it.
	const root = await makeTmpRoot(t);
	const inside = path.join(root, "example_project", "ses_A", "notes.txt");
	const outside = path.join(root, "..", "outside.txt");

	// Execution: evaluate the combinations of location and configuration.
	const subjects = {
		insideEnabled: evaluateExternal({
			root,
			resources: [inside],
			allowExternal: true,
		}),
		insideDisabled: evaluateExternal({
			root,
			resources: [inside],
			allowExternal: false,
		}),
		outsideEnabled: evaluateExternal({
			root,
			resources: [outside],
			allowExternal: true,
		}),
		mixedEnabled: evaluateExternal({
			root,
			resources: [outside, inside],
			allowExternal: true,
		}),
		mixedInsideFirst: evaluateExternal({
			root,
			resources: [inside, outside],
			allowExternal: true,
		}),
	};

	// Assertions: only an inside resource with the option enabled produces an allow.
	assert.deepEqual(subjects, {
		insideEnabled: { effect: "allow" },
		insideDisabled: undefined,
		outsideEnabled: undefined,
		mixedEnabled: { effect: "allow" },
		mixedInsideFirst: { effect: "allow" },
	});
});

test("when_the_permission_event_is_edit_then_the_adapter_writes_effect_and_message", async (t) => {
	// Setup: a mutable edit evaluation with a foreign resource and unrelated fields.
	const root = await makeTmpRoot(t);
	const ownDir = path.join(root, "example_project", "ses_A");
	const resource = path.join(root, "example_project", "ses_B", "notes.txt");
	const event: PermissionEvaluation & {
		sessionID: string;
		metadata: { source: string };
	} = {
		action: "edit",
		resources: [resource],
		effect: "allow",
		message: "configured",
		sessionID: "ses_A",
		metadata: { source: "tool" },
	};

	// Execution: run the adapter.
	applyPermission(event, {
		root,
		ownDir,
		mode: "deny",
		allowExternal: true,
	});

	// Assertions: only the plugin-owned fields change.
	assert.equal(event.effect, "deny");
	assert.equal(event.message, expectedMessage(ownDir, resource));
	assert.equal(event.action, "edit");
	assert.deepEqual(event.resources, [resource]);
	assert.equal(event.sessionID, "ses_A");
	assert.deepEqual(event.metadata, { source: "tool" });
});

test("when_the_mode_is_ask_then_the_edit_adapter_writes_ask", async (t) => {
	// Setup: a mutable edit evaluation for a foreign resource.
	const root = await makeTmpRoot(t);
	const ownDir = path.join(root, "example_project", "ses_A");
	const resource = path.join(root, "example_project", "ses_B", "notes.txt");
	const event: PermissionEvaluation = {
		action: "edit",
		resources: [resource],
		effect: "allow",
	};

	// Execution: run the adapter with `ask`.
	applyPermission(event, {
		root,
		ownDir,
		mode: "ask",
		allowExternal: true,
	});

	// Assertions: the configured effect reaches the event with the same message.
	assert.equal(event.effect, "ask");
	assert.equal(event.message, expectedMessage(ownDir, resource));
});

test("when_enforce_is_off_then_the_edit_adapter_leaves_the_event_unchanged", async (t) => {
	// Setup: a foreign edit evaluation.
	const root = await makeTmpRoot(t);
	const ownDir = path.join(root, "example_project", "ses_A");
	const resource = path.join(root, "example_project", "ses_B", "notes.txt");
	const event: PermissionEvaluation = {
		action: "edit",
		resources: [resource],
		effect: "ask",
		message: "configured",
	};
	const before = { ...event };

	// Execution: run the adapter with enforcement off.
	applyPermission(event, {
		root,
		ownDir,
		mode: "off",
		allowExternal: true,
	});

	// Assertions: the edit event is untouched.
	assert.deepEqual(event, before);
});

test("when_the_action_is_read_or_another_action_then_the_adapter_leaves_the_event_unchanged", async (t) => {
	// Setup: foreign resources seen through non-edit actions.
	const root = await makeTmpRoot(t);
	const ownDir = path.join(root, "example_project", "ses_A");
	const resource = path.join(root, "example_project", "ses_B", "notes.txt");
	const actions = ["read", "list", "shell"];

	// Execution: run the adapter for each action.
	const subjects = actions.map((action) => {
		const event: PermissionEvaluation = {
			action,
			resources: [resource],
			effect: "ask",
		};
		applyPermission(event, {
			root,
			ownDir,
			mode: "deny",
			allowExternal: true,
		});
		return event;
	});

	// Assertions: every action except `edit` and `external_directory` is untouched.
	assert.deepEqual(
		subjects,
		actions.map((action) => ({
			action,
			resources: [resource],
			effect: "ask",
		})),
	);
});

test("when_the_permission_event_is_external_directory_then_the_adapter_allows_only_inside_the_root", async (t) => {
	// Setup: inside and outside evaluations, including enforcement off.
	const root = await makeTmpRoot(t);
	const ownDir = path.join(root, "example_project", "ses_A");
	const inside = path.join(root, "example_project", "ses_A", "notes.txt");
	const outside = path.join(root, "..", "outside.txt");
	const allowed: PermissionEvaluation = {
		action: "external_directory",
		resources: [inside],
		effect: "ask",
	};
	const outsideEvent: PermissionEvaluation = {
		action: "external_directory",
		resources: [outside],
		effect: "ask",
	};
	const offEnabled: PermissionEvaluation = {
		action: "external_directory",
		resources: [inside],
		effect: "ask",
	};
	const disabled: PermissionEvaluation = {
		action: "external_directory",
		resources: [inside],
		effect: "ask",
	};

	// Execution: run the adapter under each configuration.
	applyPermission(allowed, { root, ownDir, mode: "deny", allowExternal: true });
	applyPermission(outsideEvent, {
		root,
		ownDir,
		mode: "deny",
		allowExternal: true,
	});
	applyPermission(offEnabled, {
		root,
		ownDir,
		mode: "off",
		allowExternal: true,
	});
	applyPermission(disabled, {
		root,
		ownDir,
		mode: "deny",
		allowExternal: false,
	});

	// Assertions: inside resources become allow, outside and disabled checks stay put.
	assert.equal(allowed.effect, "allow");
	assert.equal(outsideEvent.effect, "ask");
	assert.equal(offEnabled.effect, "allow");
	assert.equal(disabled.effect, "ask");
});
