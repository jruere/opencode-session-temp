/**
 * Covers write enforcement and external-directory auto-allow from README "Enforcement".
 *
 * Table cases pin documented examples; generated cases check the algebraic laws of the two pure decision functions
 * and the `applyPermission` adapter over a whole space of lexical paths. Does not cover registration and per-session
 * state, core's configured-deny precedence, or shell behavior. All paths are lexical: the table cases derive from a
 * fresh temporary root and the generated cases from a fixed one, but no project or session directory needs to exist.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import fc from "fast-check";
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

test("when_the_action_is_read_then_the_adapter_leaves_the_event_unchanged", async (t) => {
	// Setup: a foreign resource seen through a read action.
	const root = await makeTmpRoot(t);
	const ownDir = path.join(root, "example_project", "ses_A");
	const resource = path.join(root, "example_project", "ses_B", "notes.txt");
	const event: PermissionEvaluation = {
		action: "read",
		resources: [resource],
		effect: "ask",
	};

	// Execution: run the adapter.
	applyPermission(event, {
		root,
		ownDir,
		mode: "deny",
		allowExternal: true,
	});

	// Assertions: an action other than `edit` and `external_directory` is untouched.
	assert.deepEqual(event, {
		action: "read",
		resources: [resource],
		effect: "ask",
	});
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

// ---------------------------------------------------------------------------
// Generated properties
// ---------------------------------------------------------------------------
// The table cases above pin documented examples. The properties below check the algebraic laws of the two pure
// decision functions and the `applyPermission` adapter over a whole space of lexical paths: compositionality,
// normalization invariance, and the own/foreign boundary. Monotonicity follows from compositionality, so it has no
// separate property. Generators use `path.sep` and `path.join` and bias toward session-shaped segments.

const rootPrefix = path.parse(path.resolve(".")).root;
const fixedRoot = path.join(rootPrefix, "tmp", "enforce-property-tests");
const ownProject = "project_own";
const ownSegment = "ses_OWN";
const ownDir = path.join(fixedRoot, ownProject, ownSegment);

/** Safe, separator-free segments, so appending them keeps a path inside its base. */
const safeSegmentArb = fc.stringMatching(/^[A-Za-z0-9_-]{1,8}$/);

/** Projects other than the caller's; some share its textual prefix. */
const foreignProjectArb = fc.constantFrom(
	"project_f",
	"project_owne",
	"project_own2",
	"project_x",
);

/** Valid session segments for foreign directories. */
const foreignSegmentArb = fc
	.stringMatching(/^[A-Za-z0-9._-]{1,8}$/)
	.map((suffix) => `ses${suffix}`);

/** A valid sibling segment that cannot equal the caller's own `ses_OWN`. */
const siblingSegmentArb = fc
	.stringMatching(/^[A-Za-z0-9._-]{1,8}$/)
	.map((suffix) => `ses_S${suffix}`);

/** Resources inside the caller's own directory and its descendants. */
const ownResourceArb = fc
	.array(safeSegmentArb, { minLength: 0, maxLength: 4 })
	.map((segments) => path.join(ownDir, ...segments));

/** A foreign session directory itself or a descendant, in another project or a same-project sibling. */
const foreignResourceArb = fc.oneof(
	fc
		.tuple(
			foreignProjectArb,
			foreignSegmentArb,
			fc.array(safeSegmentArb, { minLength: 0, maxLength: 3 }),
		)
		.map(([project, segment, file]) =>
			path.join(fixedRoot, project, segment, ...file),
		),
	fc
		.tuple(
			siblingSegmentArb,
			fc.array(safeSegmentArb, { minLength: 0, maxLength: 3 }),
		)
		.map(([segment, file]) =>
			path.join(fixedRoot, ownProject, segment, ...file),
		),
);

/** Loose files that are inside the root but not inside any session directory. */
const looseResourceArb = fc.oneof(
	fc.constant(path.join(fixedRoot, "loose.txt")),
	safeSegmentArb.map((project) => path.join(fixedRoot, project, "notes.txt")),
);

/** Paths outside the scratch root. */
const outsideResourceArb = fc.oneof(
	fc.constant(path.join(fixedRoot, "..", "outside.txt")),
	fc
		.tuple(safeSegmentArb, safeSegmentArb)
		.map(([first, second]) => path.join(rootPrefix, first, second, "file.txt")),
);

/** A category-biased resource generator: foreign paths appear most often. */
const resourceArb = fc.oneof(
	{ weight: 3, arbitrary: foreignResourceArb },
	{ weight: 2, arbitrary: ownResourceArb },
	{ weight: 1, arbitrary: looseResourceArb },
	{ weight: 1, arbitrary: outsideResourceArb },
);

/**
 * Renders each resource as an absolute, relative, or literal-traversal spelling of the same location. Relative
 * spellings assume an unchanged `process.cwd()`, matching `path.resolve` inside the decision functions.
 */
function spelled(arb: fc.Arbitrary<string>): fc.Arbitrary<string> {
	return fc
		.tuple(arb, fc.constantFrom("absolute", "relative", "traversal"))
		.map(([resource, style]) => {
			if (style === "relative") return path.relative(process.cwd(), resource);
			if (style === "traversal") {
				return `${resource}${path.sep}descend${path.sep}..`;
			}
			return resource;
		});
}

const spelledResourceArb = spelled(resourceArb);
const spelledOwnArb = spelled(ownResourceArb);
const spelledForeignArb = spelled(foreignResourceArb);
const spelledResourcesArb = fc.array(spelledResourceArb, { maxLength: 6 });

test("when_edit_resources_are_combined_then_a_decision_exists_exactly_when_a_singleton_decides", () => {
	// Setup: arrays of generated resources mixing own, foreign, loose, and outside paths, in varied spellings.

	// Execution: classify the whole array and each of its singletons under a fixed mode.
	fc.assert(
		fc.property(spelledResourcesArb, (resources) => {
			const subject = evaluateEdit({
				root: fixedRoot,
				ownDir,
				resources,
				mode: "deny",
			});
			const singletons = resources.map((resource) =>
				evaluateEdit({
					root: fixedRoot,
					ownDir,
					resources: [resource],
					mode: "deny",
				}),
			);

			// Assertions: a combined decision exists iff some singleton decides, and it is the first such decision.
			assert.equal(
				subject !== undefined,
				singletons.some((decision) => decision !== undefined),
			);
			assert.deepEqual(
				subject,
				singletons.find((decision) => decision !== undefined),
			);
		}),
	);
});

test("when_external_resources_are_combined_then_an_allow_exists_exactly_when_a_singleton_allows", () => {
	// Setup: the same category-biased resource arrays.

	// Execution: classify the whole array and each singleton with the option enabled.
	fc.assert(
		fc.property(spelledResourcesArb, (resources) => {
			const subject = evaluateExternal({
				root: fixedRoot,
				resources,
				allowExternal: true,
			});
			const singletons = resources.map((resource) =>
				evaluateExternal({
					root: fixedRoot,
					resources: [resource],
					allowExternal: true,
				}),
			);

			// Assertions: an allow exists iff some singleton allows. Every allow is the same constant, so comparing
			// the values would add nothing.
			assert.equal(
				subject !== undefined,
				singletons.some((decision) => decision !== undefined),
			);
		}),
	);
});

test("when_external_is_disabled_then_no_resource_produces_an_allow", () => {
	// Setup: the category-biased resource arrays.

	// Execution: classify each array with the option disabled.
	fc.assert(
		fc.property(spelledResourcesArb, (resources) => {
			const subject = evaluateExternal({
				root: fixedRoot,
				resources,
				allowExternal: false,
			});

			// Assertions: the option is an absolute gate, independent of the resources.
			assert.equal(subject, undefined);
		}),
	);
});

test("when_the_edit_mode_changes_then_only_the_effect_changes", () => {
	// Setup: the category-biased resource arrays.

	// Execution: classify each array under both decision modes.
	fc.assert(
		fc.property(spelledResourcesArb, (resources) => {
			const deny = evaluateEdit({
				root: fixedRoot,
				ownDir,
				resources,
				mode: "deny",
			});
			const ask = evaluateEdit({
				root: fixedRoot,
				ownDir,
				resources,
				mode: "ask",
			});

			// Assertions: a decision exists under both modes or neither, with the same message and only the effect
			// differing.
			assert.equal(deny !== undefined, ask !== undefined);
			if (deny !== undefined && ask !== undefined) {
				assert.equal(deny.effect, "deny");
				assert.equal(ask.effect, "ask");
				assert.equal(deny.message, ask.message);
			}
		}),
	);
});

test("when_a_resource_is_resolved_then_the_edit_decision_is_unchanged", () => {
	// Setup: generated resources in absolute, relative, and literal-traversal spellings.

	// Execution: classify each spelling and its fully resolved form.
	fc.assert(
		fc.property(spelledResourceArb, (resource) => {
			const subject = evaluateEdit({
				root: fixedRoot,
				ownDir,
				resources: [resource],
				mode: "deny",
			});
			const resolved = evaluateEdit({
				root: fixedRoot,
				ownDir,
				resources: [path.resolve(resource)],
				mode: "deny",
			});

			// Assertions: normalization happens inside the decision, so the spelling cannot change the result.
			assert.deepEqual(subject, resolved);
		}),
	);
});

test("when_a_resource_is_resolved_then_the_external_decision_is_unchanged", () => {
	// Setup: the same spelled resources.

	// Execution: classify each spelling and its fully resolved form.
	fc.assert(
		fc.property(spelledResourceArb, (resource) => {
			const subject = evaluateExternal({
				root: fixedRoot,
				resources: [resource],
				allowExternal: true,
			});
			const resolved = evaluateExternal({
				root: fixedRoot,
				resources: [path.resolve(resource)],
				allowExternal: true,
			});

			// Assertions: the allow decision depends only on the resolved location.
			assert.deepEqual(subject, resolved);
		}),
	);
});

test("when_a_resource_is_inside_the_own_directory_then_no_edit_decision_is_produced", () => {
	// Setup: generated descendants of the caller's own directory, in varied spellings.

	// Execution: classify each own-directory resource.
	fc.assert(
		fc.property(spelledOwnArb, (resource) => {
			const subject = evaluateEdit({
				root: fixedRoot,
				ownDir,
				resources: [resource],
				mode: "deny",
			});

			// Assertions: the own directory and everything below it is always left alone.
			assert.equal(subject, undefined);
		}),
	);
});

test("when_a_resource_is_in_a_foreign_session_directory_then_it_is_blocked_with_a_naming_message", () => {
	// Setup: generated resources in foreign session directories, in varied spellings.

	// Execution: classify each foreign resource.
	fc.assert(
		fc.property(spelledForeignArb, (resource) => {
			const resolved = path.resolve(resource);
			const subject = evaluateEdit({
				root: fixedRoot,
				ownDir,
				resources: [resource],
				mode: "deny",
			});

			// Assertions: every foreign resource is blocked, and the message names the caller's directory and the
			// resolved resource.
			assert.deepEqual(subject, {
				effect: "deny",
				message: `Session ${path.basename(ownDir)} may only write inside ${ownDir}; ${resolved} belongs to another session.`,
			});
		}),
	);
});

test("when_a_resource_is_outside_the_root_or_loose_under_it_then_no_edit_decision_is_produced", () => {
	// Setup: generated loose and outside resources.
	const unenforcedArb = spelled(fc.oneof(looseResourceArb, outsideResourceArb));

	// Execution: classify each one.
	fc.assert(
		fc.property(unenforcedArb, (resource) => {
			const subject = evaluateEdit({
				root: fixedRoot,
				ownDir,
				resources: [resource],
				mode: "deny",
			});

			// Assertions: paths outside the root or not in any session directory are left alone.
			assert.equal(subject, undefined);
		}),
	);
});

interface RichEvaluation extends PermissionEvaluation {
	sessionID: string;
	metadata: { source: string };
}

test("when_the_adapter_applies_a_permission_then_it_writes_only_effect_and_message_idempotently", () => {
	// Setup: a generated event with arbitrary fields and a generated configuration.
	const eventArb = fc.record({
		action: fc.constantFrom("edit", "external_directory", "read"),
		resources: spelledResourcesArb,
		effect: fc.constantFrom("allow", "deny", "ask"),
		message: fc.string(),
		sessionID: fc.string(),
		source: fc.string(),
	});
	const configArb = fc.record({
		mode: fc.constantFrom("deny", "ask", "off"),
		allowExternal: fc.boolean(),
	});

	// Execution: apply the adapter twice to the same mutable event.
	fc.assert(
		fc.property(eventArb, configArb, (fields, config) => {
			const event: RichEvaluation = {
				action: fields.action,
				resources: fields.resources,
				effect: fields.effect,
				message: fields.message,
				sessionID: fields.sessionID,
				metadata: { source: fields.source },
			};
			const before = {
				...event,
				resources: [...event.resources],
				metadata: { ...event.metadata },
			};
			const options = {
				root: fixedRoot,
				ownDir,
				mode: config.mode,
				allowExternal: config.allowExternal,
			};
			applyPermission(event, options);
			const afterFirst = {
				...event,
				resources: [...event.resources],
				metadata: { ...event.metadata },
			};
			applyPermission(event, options);

			// Assertions: a second application changes nothing, so the adapter is idempotent.
			assert.deepEqual(event, afterFirst);

			// Assertions: only `effect` and `message` may differ; every other field is preserved.
			assert.equal(event.action, before.action);
			assert.deepEqual(event.resources, before.resources);
			assert.equal(event.sessionID, before.sessionID);
			assert.deepEqual(event.metadata, before.metadata);

			// Assertions: the new effect and message match the pure decision for this action and configuration.
			let expectedEffect: "allow" | "deny" | "ask" = before.effect;
			let expectedMessage = before.message;
			if (fields.action === "edit" && config.mode !== "off") {
				const decision = evaluateEdit({
					root: fixedRoot,
					ownDir,
					resources: fields.resources,
					mode: config.mode,
				});
				if (decision !== undefined) {
					expectedEffect = decision.effect;
					expectedMessage = decision.message;
				}
			} else if (fields.action === "external_directory") {
				const decision = evaluateExternal({
					root: fixedRoot,
					resources: fields.resources,
					allowExternal: config.allowExternal,
				});
				if (decision !== undefined) expectedEffect = decision.effect;
			}
			assert.equal(event.effect, expectedEffect);
			assert.equal(event.message, expectedMessage);
		}),
	);
});
