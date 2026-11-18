/**
 * Covers the filesystem error classifiers in src/fs-errors.ts: exact code membership for each predicate and the
 * cross-predicate laws the sweep and lifecycle walkers rely on.
 *
 * Deliberately does not cover the walkers that consume these predicates, real Node.js error objects, or which code
 * a given filesystem operation produces. Inputs are generated as plain data so arbitrary `unknown` shapes are
 * exercised, not just a hand-picked list of errno strings.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import {
	isDestinationExists,
	isMissing,
	isNotEmpty,
} from "../src/fs-errors.ts";

const missingCodes = new Set<string>(["ENOENT", "ENOTDIR"]);
const notEmptyCodes = new Set<string>(["ENOTEMPTY", "EEXIST"]);
const destinationCodes = new Set<string>(["ENOTEMPTY", "EEXIST", "EISDIR"]);

const interestingCodes = [
	"ENOENT",
	"ENOTDIR",
	"ENOTEMPTY",
	"EEXIST",
	"EISDIR",
	"EACCES",
	"EPERM",
	"EBUSY",
	"ENOSPC",
];

/** Error-shaped values biased toward the codes the predicates actually classify. */
const errorArb: fc.Arbitrary<unknown> = fc.oneof(
	fc.record({
		code: fc.oneof(fc.constantFrom(...interestingCodes), fc.string()),
	}),
	fc.anything(),
);

test("when_an_error_has_an_arbitrary_string_code_then_each_predicate_accepts_only_its_documented_codes", () => {
	// Setup: a generator biased toward the documented errno codes and arbitrary strings.
	const codeArb = fc.oneof(fc.constantFrom(...interestingCodes), fc.string());

	// Execution: for each generated code, classify one error object with all three predicates.
	fc.assert(
		fc.property(codeArb, (code) => {
			const subject = { code };
			const missing = isMissing(subject);
			const notEmpty = isNotEmpty(subject);
			const destinationExists = isDestinationExists(subject);

			// Assertions: membership is exactly the documented set for each predicate.
			assert.equal(missing, missingCodes.has(code));
			assert.equal(notEmpty, notEmptyCodes.has(code));
			assert.equal(destinationExists, destinationCodes.has(code));
		}),
	);
});

test("when_an_error_is_not_an_object_with_a_string_code_then_no_predicate_classifies_it", () => {
	// Setup: values that are not objects, objects without `code`, and objects with a non-string `code`.
	const malformedArb: fc.Arbitrary<unknown> = fc.oneof(
		fc.string(),
		fc.integer(),
		fc.boolean(),
		fc.constant(null),
		fc.constant(undefined),
		fc.record({ other: fc.string() }),
		fc.record({
			code: fc.oneof(fc.integer(), fc.boolean(), fc.constant(null)),
		}),
	);

	// Execution: classify every generated value.
	fc.assert(
		fc.property(malformedArb, (subject) => {
			const missing = isMissing(subject);
			const notEmpty = isNotEmpty(subject);
			const destinationExists = isDestinationExists(subject);

			// Assertions: none of the predicates claims a malformed value.
			assert.equal(missing, false);
			assert.equal(notEmpty, false);
			assert.equal(destinationExists, false);
		}),
	);
});

test("when_errors_are_generated_then_missing_and_collision_predicates_are_disjoint", () => {
	// Setup: error-shaped values and arbitrary values, so the law holds for classified and unclassified inputs.

	// Execution: classify each generated value with the predicates that must never both fire.
	fc.assert(
		fc.property(errorArb, (subject) => {
			const missing = isMissing(subject);
			const notEmpty = isNotEmpty(subject);
			const destinationExists = isDestinationExists(subject);

			// Assertions: a missing-entry code is never also a collision code, in either pairing.
			assert.equal(missing && destinationExists, false);
			assert.equal(missing && notEmpty, false);
		}),
	);
});

test("when_an_error_is_not_empty_then_it_also_counts_as_a_destination_collision", () => {
	// Setup: the same biased generator; `EISDIR` is the witness that makes the subset strict.

	// Execution: classify each generated value with both collision predicates.
	fc.assert(
		fc.property(errorArb, (subject) => {
			const notEmpty = isNotEmpty(subject);
			const destinationExists = isDestinationExists(subject);

			// Assertions: every not-empty code is also a destination-collision code.
			assert.equal(notEmpty && !destinationExists, false);
		}),
	);

	// Assertions: the extra `EISDIR` code widens the destination set without joining the not-empty set.
	assert.equal(isNotEmpty({ code: "EISDIR" }), false);
	assert.equal(isDestinationExists({ code: "EISDIR" }), true);
});
