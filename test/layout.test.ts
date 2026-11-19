/**
 * Covers project slug derivation, session segment validation, containment, and the per-session scratch layout
 * from README "Layout". Table-driven cases pin documented examples; generated cases check the laws that hold over
 * the whole lexical path space, including prefix, traversal, and unicode spellings.
 *
 * Does not cover directory creation, instruction rewriting, permission decisions, or cleanup. Generated paths are
 * lexical strings built from `path.sep` and `path.join`, while table cases use a fresh temporary root, never the
 * production default. The CRC32 hash is not assumed injective: distinct directory/project pairs may share a slug.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import fc from "fast-check";
import {
	isInside,
	isSessionSegment,
	projectSlug,
	resolveLayout,
	sessionSegment,
} from "../src/layout.ts";
import { makeTmpRoot } from "./helpers/tmp-root.ts";

const slugSuffix = /-[a-z2-7]{7}$/;

test("when_directory_has_two_normal_segments_then_the_slug_joins_them_with_an_underscore", async (t) => {
	// Setup: a project directory whose last two segments are readable as-is.
	const root = await makeTmpRoot(t);
	const directory = path.join(root, "example", "web-app");

	// Execution: derive the slug with a fixed project ID.
	const subject = projectSlug(directory, "prj_typical");

	// Assertions: both segments are joined by `_` and a hash suffix follows.
	assert.match(subject, /^example_web-app-[a-z2-7]{7}$/);
});

test("when_two_directories_share_the_last_two_segments_then_their_slugs_differ", async (t) => {
	// Setup: two absolute directories whose last two segments are identical.
	const root = await makeTmpRoot(t);
	const first = path.join(root, "a", "b", "c");
	const second = path.join(root, "x", "b", "c");

	// Execution: derive the slug for the same project ID.
	const firstSlug = projectSlug(first, "prj_shared");
	const secondSlug = projectSlug(second, "prj_shared");

	// Assertions: the readable part is shared, and the checksum keeps the slugs distinct.
	assert.match(firstSlug, /^b_c-[a-z2-7]{7}$/);
	assert.match(secondSlug, /^b_c-[a-z2-7]{7}$/);
	assert.notEqual(firstSlug, secondSlug);
});

test("when_project_ids_differ_then_it_gives_different_slugs", async (t) => {
	// Setup: one directory resolved for two projects.
	const root = await makeTmpRoot(t);
	const directory = path.join(root, "acme", "dashboard");

	// Execution: derive both slugs.
	const first = projectSlug(directory, "prj_one");
	const second = projectSlug(directory, "prj_two");

	// Assertions: the readable part matches and only the hash distinguishes them.
	assert.match(first, /^acme_dashboard-[a-z2-7]{7}$/);
	assert.match(second, /^acme_dashboard-[a-z2-7]{7}$/);
	assert.notEqual(first, second);
});

test("when_directory_is_a_filesystem_root_then_the_readable_part_is_root", async (t) => {
	// Setup: the root of the filesystem holding the temporary directory.
	const root = await makeTmpRoot(t);
	const filesystemRoot = path.parse(root).root;

	// Execution: derive the slug.
	const subject = projectSlug(filesystemRoot, "prj_root");

	// Assertions: the readable part is `root`, not an empty segment.
	assert.match(subject, /^root-[a-z2-7]{7}$/);
});

test("when_directory_is_a_home_directory_then_the_readable_part_is_home_and_the_user", async (t) => {
	// Setup: a typical home directory path with no special casing in the layout.
	const root = await makeTmpRoot(t);
	const home = path.join(path.parse(root).root, "home", "jdoe");

	// Execution: derive the slug.
	const subject = projectSlug(home, "prj_home");

	// Assertions: both segments are kept and joined like any other directory.
	assert.match(subject, /^home_jdoe-[a-z2-7]{7}$/);
});

test("when_segments_contain_dots_underscores_or_whitespace_then_they_are_removed", async (t) => {
	// Setup: segments with the characters the README removes before assembly.
	const root = await makeTmpRoot(t);
	const directory = path.join(root, "my.project", "web_app v2");

	// Execution: derive the slug.
	const subject = projectSlug(directory, "prj_stripped");

	// Assertions: the readable part has no dots, underscores, or spaces inside its segments.
	assert.match(subject, /^myproject_webappv2-[a-z2-7]{7}$/);
});

test("when_segments_contain_unsafe_characters_then_the_readable_part_has_no_separators", async (t) => {
	// Setup: segments with punctuation that must not reach the filesystem.
	const root = await makeTmpRoot(t);
	const directory = path.join(root, "a@b", "c:d*e");

	// Execution: derive the slug.
	const subject = projectSlug(directory, "prj_unsafe");

	// Assertions: unsafe characters became single hyphens and no separator or dot segment survived.
	assert.match(subject, /^a-b_c-d-e-[a-z2-7]{7}$/);
	assert.equal(subject.includes(path.sep), false);
	assert.equal(subject.split("_").includes(".."), false);
});

test("when_two_directories_strip_to_the_same_readable_part_then_their_slugs_differ", async (t) => {
	// Setup: two directories whose stripped last two segments are identical.
	const root = await makeTmpRoot(t);
	const first = path.join(root, "a b", "c");
	const second = path.join(root, "ab", "c");

	// Execution: derive both slugs.
	const firstSlug = projectSlug(first, "prj_lossy");
	const secondSlug = projectSlug(second, "prj_lossy");

	// Assertions: the readable part is lossy and the hash covers the full directory.
	assert.match(firstSlug, /^ab_c-[a-z2-7]{7}$/);
	assert.match(secondSlug, /^ab_c-[a-z2-7]{7}$/);
	assert.notEqual(firstSlug, secondSlug);
});

test("when_both_segments_strip_to_empty_then_the_readable_part_is_project", async (t) => {
	// Setup: a directory whose last two segments consist only of stripped characters.
	const root = await makeTmpRoot(t);
	const directory = path.join(root, "...", "___");

	// Execution: derive the slug.
	const subject = projectSlug(directory, "prj_empty");

	// Assertions: the documented fallback readable part is used.
	assert.match(subject, /^project-[a-z2-7]{7}$/);
});

test("when_directory_and_project_id_are_known_then_the_hash_matches_the_documented_encoding", () => {
	// Setup: a fixed POSIX directory and project ID with an independently computed CRC32 and base32 value.
	const directory = "/a/b/c";
	const projectID = "prj_test";

	// Execution: derive the slug.
	const subject = projectSlug(directory, projectID);

	// Assertions: 0x1fc1182e encodes as the documented lowercase RFC 4648 base32 suffix.
	assert.equal(subject, "b_c-d7arqlq");
});

test("when_the_last_segment_is_long_then_the_readable_part_keeps_the_last_48_characters", async (t) => {
	// Setup: a project directory whose joined readable part is longer than the cap.
	const root = await makeTmpRoot(t);
	const directory = path.join(root, "p", "x".repeat(80));

	// Execution: derive the slug.
	const subject = projectSlug(directory, "prj_long");

	// Assertions: the readable part is capped at 48 characters and the slug at 56 bytes.
	assert.match(subject, /^x{48}-[a-z2-7]{7}$/);
	assert.equal(Buffer.byteLength(subject, "utf8"), 56);
});

test("when_directory_contains_dot_segments_then_the_slug_uses_the_resolved_path", async (t) => {
	// Setup: one plain directory and a literal path that resolves to it through `..`.
	const root = await makeTmpRoot(t);
	const plain = path.join(root, "acme", "dashboard");
	// Concatenate instead of using path.join: joining would resolve `..` before projectSlug can.
	const dotted = `${root}${path.sep}acme${path.sep}ignored${path.sep}..${path.sep}dashboard`;

	// Execution: derive the slug from the unresolved spelling.
	const subject = projectSlug(dotted, "prj_dots");

	// Assertions: resolution happens before both readability and hashing.
	assert.equal(subject, projectSlug(plain, "prj_dots"));
	assert.match(subject, /^acme_dashboard-[a-z2-7]{7}$/);
});

test("when_segments_have_punctuation_or_outer_hyphens_then_runs_collapse_and_edges_trim", async (t) => {
	// Setup: one segment with repeated unsafe characters and one with hyphen runs at its edges.
	const root = await makeTmpRoot(t);
	const directory = path.join(root, "a!!b", "--c--");

	// Execution: derive the slug.
	const subject = projectSlug(directory, "prj_edge");

	// Assertions: runs collapse and edges trim before the segments are joined.
	assert.match(subject, /^a-b_c-[a-z2-7]{7}$/);
});

test("when_one_segment_strips_to_empty_then_the_other_remains", async (t) => {
	// Setup: a project directory whose parent segment consists only of stripped characters.
	const root = await makeTmpRoot(t);
	const directory = path.join(root, "...", "app");

	// Execution: derive the slug.
	const subject = projectSlug(directory, "prj_partial");

	// Assertions: the empty segment is dropped without leaving an extra underscore.
	assert.match(subject, /^app-[a-z2-7]{7}$/);
});

test("when_session_id_is_valid_then_it_is_used_verbatim", () => {
	// Setup: valid session IDs, including punctuation the rules allow.
	const valid = ["ses_A", "ses.AB-CD_12", "ses_1750000000000_abc"];

	// Execution: validate each ID.
	const subjects = valid.map((sessionID) => sessionSegment(sessionID));

	// Assertions: each valid ID is returned unchanged.
	assert.deepEqual(subjects, valid);
});

test("when_session_id_is_invalid_then_the_fallback_is_a_single_safe_segment", () => {
	// Setup: IDs with separators, traversal, empty input, or no `ses` prefix.
	const invalid = ["ses/bad", "..", "", ".", "ses", "SES_upper", "/"];

	// Execution: validate each ID twice.
	const subjects = invalid.map((sessionID) => sessionSegment(sessionID));
	const repeated = invalid.map((sessionID) => sessionSegment(sessionID));

	// Assertions: each result is one safe segment, ends with 8 hex characters, and no two collide.
	for (const [index, subject] of subjects.entries()) {
		assert.match(subject, /^ses[A-Za-z0-9._-]+$/);
		assert.match(subject, /-[0-9a-f]{8}$/);
		assert.equal(subject.includes(path.sep), false);
		assert.notEqual(subject, invalid[index]);
	}
	assert.equal(new Set(subjects).size, subjects.length);
	assert.deepEqual(repeated, subjects);
});

test("when_layout_is_resolved_then_the_session_directory_is_under_the_project_directory", async (t) => {
	// Setup: a session with its own location and project ID.
	const root = await makeTmpRoot(t);
	const directory = path.join(root, "acme", "dashboard");
	const session = {
		sessionID: "ses_layout",
		projectID: "prj_layout",
		location: { directory },
	};

	// Execution: resolve the layout under the temporary root.
	const subject = resolveLayout(root, session);

	// Assertions: the project directory and the session directory follow the documented shape.
	assert.match(subject.projectSlug, /^acme_dashboard-[a-z2-7]{7}$/);
	assert.equal(subject.projectDir, path.join(root, subject.projectSlug));
	assert.equal(subject.sessionDir, path.join(subject.projectDir, "ses_layout"));
	assert.equal(isInside(root, subject.projectDir), true);
	assert.equal(isInside(subject.projectDir, subject.sessionDir), true);
});

test("when_session_has_no_usable_location_or_project_then_the_layout_falls_back_to_global", async (t) => {
	// Setup: sessions missing a location, a project ID, or both values.
	const root = await makeTmpRoot(t);
	const sessions = [
		{ sessionID: "ses_global", projectID: "prj_global" },
		{ sessionID: "ses_global", location: { directory: "/tmp/example" } },
		{ sessionID: "ses_global", projectID: "", location: { directory: "" } },
	];

	// Execution: resolve each layout.
	const subjects = sessions.map((session) => resolveLayout(root, session));

	// Assertions: every unusable session lands in the shared `global` project.
	for (const subject of subjects) {
		assert.equal(subject.projectSlug, "global");
		assert.equal(subject.projectDir, path.join(root, "global"));
		assert.equal(subject.sessionDir, path.join(root, "global", "ses_global"));
	}
});

test("when_session_id_is_unsafe_then_the_session_directory_cannot_escape_its_project", async (t) => {
	// Setup: a session with a usable project but a traversal-shaped ID.
	const root = await makeTmpRoot(t);
	const directory = path.join(root, "acme", "dashboard");
	const session = {
		sessionID: "../evil",
		projectID: "prj_evil",
		location: { directory },
	};

	// Execution: resolve the layout.
	const subject = resolveLayout(root, session);

	// Assertions: the validated segment keeps the path inside the project directory.
	assert.match(subject.projectSlug, slugSuffix);
	assert.equal(
		subject.sessionDir,
		path.join(subject.projectDir, sessionSegment("../evil")),
	);
	assert.equal(isInside(subject.projectDir, subject.sessionDir), true);
	assert.equal(isInside(root, subject.sessionDir), true);
});

test("when_paths_are_compared_then_containment_is_segment_aware_and_strict", () => {
	// Setup: parent and child paths covering descendants, equality, prefix collisions, and traversal.
	const parent = path.join(path.sep, "a", "b");
	// The `..` cases are literal on purpose: path.join would normalize them before isInside sees the input.
	const cases: Array<[string, boolean]> = [
		[path.join(parent, "c"), true],
		[path.join(parent, "c", "d"), true],
		[`${parent}${path.sep}c${path.sep}..${path.sep}d`, true],
		[parent, false],
		[path.join(path.sep, "a", "bc"), false],
		[path.join(path.sep, "a"), false],
		[`${parent}${path.sep}..${path.sep}c`, false],
	];

	// Execution: test each pair.
	const subjects = cases.map(([child]) => isInside(parent, child));

	// Assertions: only strict descendants are inside.
	assert.deepEqual(
		subjects,
		cases.map(([, expected]) => expected),
	);
});

test("when_layout_is_resolved_twice_then_the_paths_are_identical", async (t) => {
	// Setup: one session and project resolved twice.
	const root = await makeTmpRoot(t);
	const directory = path.join(root, "acme", "dashboard");
	const session = {
		sessionID: "ses_stable",
		projectID: "prj_stable",
		location: { directory },
	};

	// Execution: resolve the layout again.
	const first = resolveLayout(root, session);
	const second = resolveLayout(root, session);

	// Assertions: derivation is deterministic.
	assert.deepEqual(second, first);
});

const rootPrefix = path.parse(path.resolve(".")).root;
const fixedRoot = path.join(rootPrefix, "tmp", "opencode-property-tests");

/** Non-empty, separator-free segments, so joining them always yields a strict descendant. */
const safeSegmentArb = fc.stringMatching(/^[A-Za-z0-9_-]{1,8}$/);

/** Segments with the spellings that tend to break lexical containment checks. */
const pathSegmentArb = fc.oneof(
	fc.constant("."),
	fc.constant(".."),
	fc.constant(""),
	fc.constant("b"),
	fc.constant("bc"),
	fc.constant("ses_A"),
	fc.constant("ses_AB"),
	fc.constant("é"),
	fc.constant(" "),
	safeSegmentArb,
);

const segmentsArb = fc.array(pathSegmentArb, { minLength: 0, maxLength: 6 });

/** Absolute lexical paths; literal joins keep `.`, `..`, and empty segments in the spelling. */
const absolutePathArb = segmentsArb.map(
	(segments) => rootPrefix + segments.join(path.sep),
);

/** Relative lexical paths, including `..` prefixes and the empty-path spelling. */
const relativePathArb = segmentsArb.map((segments) => segments.join(path.sep));

/** Absolute paths with literal `..` segments that a resolver must collapse. */
const traversalPathArb = fc
	.tuple(absolutePathArb, pathSegmentArb, pathSegmentArb)
	.map(([base, one, two]) => `${base}${path.sep}${one}${path.sep}${two}`);

/** A mix of absolute, relative, and traversal-shaped path strings. */
const pathArb = fc.oneof(absolutePathArb, relativePathArb, traversalPathArb);

/** Session IDs that satisfy `isSessionSegment` by construction. */
const validSegmentArb = fc
	.stringMatching(/^[A-Za-z0-9._-]{1,12}$/)
	.map((suffix) => `ses${suffix}`);

/** Session IDs with the spellings the sanitizer has to repair. */
const rawSessionIDArb = fc.oneof(
	validSegmentArb,
	fc.string({ maxLength: 60 }),
	fc.string({ minLength: 200, maxLength: 400 }),
	fc.constant(""),
	fc.constant(".."),
	fc.constant(path.sep),
	fc.constant("ses"),
	fc.constant("SES_upper"),
);

const projectIDArb = fc.oneof(
	fc.string({ maxLength: 80 }),
	fc.constant(""),
	fc.constant("prj_1"),
);

/** A session as `resolveLayout` receives it: the location directory is nested under `location`. */
const sessionArb = fc.oneof(
	{
		weight: 4,
		arbitrary: fc.record({
			sessionID: rawSessionIDArb,
			projectID: projectIDArb,
			location: fc.record({ directory: pathArb }),
		}),
	},
	{ weight: 1, arbitrary: fc.record({ sessionID: rawSessionIDArb }) },
);

/** Splits a slug at its last hyphen, which separates the readable part from the hash. */
function splitSlug(slug: string): { readable: string; hash: string } {
	const dash = slug.lastIndexOf("-");
	return { readable: slug.slice(0, dash), hash: slug.slice(dash + 1) };
}

test("when_a_path_is_compared_with_itself_then_it_is_not_inside_itself", () => {
	// Setup: absolute paths generated from arbitrary segment lists.

	// Execution: compare every generated path with itself.
	fc.assert(
		fc.property(pathArb, (subject) => {
			// Assertions: containment is irreflexive.
			assert.equal(isInside(subject, subject), false);
		}),
	);
});

test("when_two_paths_are_compared_in_both_directions_then_at_most_one_contains_the_other", () => {
	// Setup: two independently generated path spellings.

	// Execution: classify both orientations.
	fc.assert(
		fc.property(pathArb, pathArb, (first, second) => {
			// Assertions: containment is antisymmetric.
			assert.equal(isInside(first, second) && isInside(second, first), false);
		}),
	);
});

test("when_three_paths_form_a_descendant_chain_then_containment_is_transitive", () => {
	// Setup: a base path and two safe segments appended in sequence.
	const chainArb = fc
		.tuple(absolutePathArb, safeSegmentArb, safeSegmentArb)
		.map(([base, first, second]) => ({
			parent: base,
			middle: path.join(base, first),
			child: path.join(base, first, second),
		}));

	// Execution: classify each link and the shortcut from parent to child.
	fc.assert(
		fc.property(chainArb, ({ parent, middle, child }) => {
			// Assertions: the chain is strict at each step and transitive overall.
			assert.equal(isInside(parent, middle), true);
			assert.equal(isInside(middle, child), true);
			assert.equal(isInside(parent, child), true);
		}),
	);
});

test("when_a_path_is_a_sibling_with_a_shared_prefix_then_it_is_not_inside_the_other", () => {
	// Setup: a generated base path and two names where one is a strict textual prefix of the other.
	const siblingArb = fc
		.tuple(absolutePathArb, safeSegmentArb)
		.map(([base, name]) => ({
			parent: path.join(base, name),
			sibling: path.join(base, `${name}x`),
		}));

	// Execution: classify the pair in both directions.
	fc.assert(
		fc.property(siblingArb, ({ parent, sibling }) => {
			// Assertions: a shared textual prefix is not segment-aware containment.
			assert.equal(isInside(parent, sibling), false);
			assert.equal(isInside(sibling, parent), false);
		}),
	);
});

test("when_paths_are_resolved_then_containment_does_not_change", () => {
	// Setup: absolute, relative, and traversal-shaped spellings, paired independently so mixed cases occur.

	// Execution: classify the original pair and the fully resolved pair.
	fc.assert(
		fc.property(pathArb, pathArb, (parent, child) => {
			const subject = isInside(parent, child);
			const resolved = isInside(path.resolve(parent), path.resolve(child));

			// Assertions: `path.relative` resolves its arguments anyway, so resolution is a no-op for the predicate.
			assert.equal(subject, resolved);
		}),
	);
});

test("when_a_session_id_is_repaired_then_the_result_is_a_valid_single_segment", () => {
	// Setup: valid IDs, separators, traversal, empty input, unicode, and very long strings.

	// Execution: sanitize each generated ID.
	fc.assert(
		fc.property(rawSessionIDArb, (sessionID) => {
			const subject = sessionSegment(sessionID);

			// Assertions: every result is a non-empty `ses`-prefixed single path segment. The extra checks keep the
			// property falsifiable even if `isSessionSegment` itself became permissive.
			assert.equal(isSessionSegment(subject), true);
			assert.equal(subject.includes(path.sep), false);
			assert.notEqual(subject, "");
			assert.equal(subject.startsWith("ses"), true);
		}),
	);
});

test("when_a_session_id_is_already_valid_then_it_is_used_verbatim", () => {
	// Setup: IDs that satisfy the documented pattern by construction.

	// Execution: validate and sanitize each one.
	fc.assert(
		fc.property(validSegmentArb, (sessionID) => {
			// Assertions: validation accepts them and sanitization is the identity.
			assert.equal(isSessionSegment(sessionID), true);
			assert.equal(sessionSegment(sessionID), sessionID);
		}),
	);
});

test("when_a_slug_is_derived_then_it_is_well_formed", () => {
	// Setup: arbitrary location directories and project IDs.

	// Execution: derive a slug for each generated pair.
	fc.assert(
		fc.property(pathArb, projectIDArb, (directory, projectID) => {
			const subject = projectSlug(directory, projectID);
			const parts = splitSlug(subject);

			// Assertions: the 7-character base32 suffix, restricted readable part, and byte cap all hold.
			assert.match(parts.hash, /^[a-z2-7]{7}$/);
			assert.match(parts.readable, /^[A-Za-z0-9_-]+$/);
			assert.equal(parts.readable.length <= 48, true);
			assert.equal(Buffer.byteLength(subject, "utf8") <= 56, true);
			assert.equal(subject.includes(path.sep), false);
			assert.equal(subject.split("_").includes(".."), false);
		}),
	);
});

test("when_a_directory_spelling_resolves_through_dot_segments_then_the_slug_is_unchanged", () => {
	// Setup: a plain absolute path and a spelling that reaches it through `ignored/..`.
	const dottedPairArb = fc
		.tuple(absolutePathArb, safeSegmentArb, projectIDArb)
		.map(([base, segment, projectID]) => ({
			plain: path.join(base, segment),
			dotted: `${base}${path.sep}ignored${path.sep}..${path.sep}${segment}`,
			projectID,
		}));

	// Execution: derive the slug from both spellings.
	fc.assert(
		fc.property(dottedPairArb, ({ plain, dotted, projectID }) => {
			const subject = projectSlug(dotted, projectID);

			// Assertions: resolution happens before readability and hashing.
			assert.equal(subject, projectSlug(plain, projectID));
			assert.equal(subject, projectSlug(path.resolve(dotted), projectID));
		}),
	);
});

test("when_many_sessions_are_resolved_then_each_session_directory_is_a_strict_descendant_of_its_project_directory", () => {
	// Setup: an array of generated sessions with mixed IDs, projects, and location directories.
	const sessionsArb = fc.array(sessionArb, { minLength: 0, maxLength: 12 });

	// Execution: resolve every layout under a fixed lexical root.
	fc.assert(
		fc.property(sessionsArb, (sessions) => {
			const subjects = sessions.map((session) =>
				resolveLayout(fixedRoot, session),
			);

			// Assertions: both directories sit under the injected root, compose as documented, and the last
			// segment is the validated session ID.
			for (const [index, subject] of subjects.entries()) {
				const segment = sessionSegment(sessions[index]?.sessionID ?? "");
				assert.equal(isInside(fixedRoot, subject.projectDir), true);
				assert.equal(isInside(fixedRoot, subject.sessionDir), true);
				assert.equal(
					subject.projectDir,
					path.join(fixedRoot, subject.projectSlug),
				);
				assert.equal(
					subject.sessionDir,
					path.join(subject.projectDir, segment),
				);
				assert.equal(isInside(subject.projectDir, subject.sessionDir), true);
			}
		}),
	);
});

test("when_many_sessions_are_resolved_then_no_session_directory_contains_another", () => {
	// Setup: an array of generated sessions, plus one session spread over many project directories.
	const sessionsArb = fc.array(sessionArb, { minLength: 0, maxLength: 12 });
	const spreadArb = fc
		.tuple(rawSessionIDArb, fc.array(projectIDArb), fc.array(pathArb))
		.map(([sessionID, projectIDs, directories]) =>
			projectIDs.map((projectID, index) => ({
				sessionID,
				projectID,
				location: {
					directory: directories[index % Math.max(directories.length, 1)] ?? "",
				},
			})),
		);

	// Execution: resolve every layout in both groups.
	fc.assert(
		fc.property(sessionsArb, spreadArb, (sessions, spread) => {
			const subjects = [...sessions, ...spread].map((session) =>
				resolveLayout(fixedRoot, session),
			);

			// Assertions: every directory stays under the injected root and no session directory is a strict
			// descendant of another. Strict containment already excludes equality, so no identity skip is needed.
			for (const first of subjects) {
				assert.equal(isInside(fixedRoot, first.sessionDir), true);
				for (const second of subjects) {
					assert.equal(isInside(first.sessionDir, second.sessionDir), false);
				}
			}
		}),
	);
});
