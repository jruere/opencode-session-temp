/**
 * Permission decisions for the scratch root (README "Enforcement").
 *
 * `evaluateEdit` and `evaluateExternal` are pure and operate on lexical paths. `applyPermission` is the thin
 * adapter core calls: it reads the mutable evaluation, delegates the decision, and writes back only the fields
 * the plugin owns.
 */
import path from "node:path";
import { isInside, isSessionSegment } from "./layout.ts";

export interface PermissionEvaluation {
	readonly action: string;
	readonly resources: ReadonlyArray<string>;
	effect: "allow" | "deny" | "ask";
	message?: string;
}

export interface EditDecision {
	readonly effect: "deny" | "ask";
	readonly message: string;
}

export interface PermissionOptions {
	readonly root: string;
	readonly ownDir: string;
	readonly mode: "deny" | "ask" | "off";
	readonly allowExternal: boolean;
}

/** Returns the configured effect when a resource belongs to another session. */
export function evaluateEdit(input: {
	root: string;
	ownDir: string;
	resources: readonly string[];
	mode: "deny" | "ask";
}): EditDecision | undefined {
	const root = path.resolve(input.root);
	const ownDir = path.resolve(input.ownDir);

	for (const resource of input.resources) {
		const resolved = normalizeResource(resource);
		if (!isInside(root, resolved)) continue;
		if (resolved === ownDir || isInside(ownDir, resolved)) continue;
		if (!isInForeignSessionDirectory(root, resolved)) continue;

		return {
			effect: input.mode,
			message: `Session ${path.basename(ownDir)} may only write inside ${ownDir}; ${resolved} belongs to another session.`,
		};
	}

	return undefined;
}

/** Allows external-directory checks inside the root when configured. */
export function evaluateExternal(input: {
	root: string;
	resources: readonly string[];
	allowExternal: boolean;
}): { effect: "allow" } | undefined {
	if (!input.allowExternal) return undefined;

	const root = path.resolve(input.root);
	const inside = input.resources.some((resource) =>
		isInside(root, normalizeResource(resource)),
	);
	return inside ? { effect: "allow" } : undefined;
}

/** Applies the decision to a mutable permission evaluation. */
export function applyPermission(
	event: PermissionEvaluation,
	options: PermissionOptions,
): void {
	if (event.action === "edit") {
		if (options.mode === "off") return;

		const decision = evaluateEdit({
			root: options.root,
			ownDir: options.ownDir,
			resources: event.resources,
			mode: options.mode,
		});
		if (decision === undefined) return;

		event.effect = decision.effect;
		event.message = decision.message;
		return;
	}

	if (event.action === "external_directory") {
		const decision = evaluateExternal({
			root: options.root,
			resources: event.resources,
			allowExternal: options.allowExternal,
		});
		if (decision !== undefined) event.effect = decision.effect;
	}
}

function normalizeResource(resource: string): string {
	return path.resolve(resource);
}

function isInForeignSessionDirectory(root: string, resource: string): boolean {
	const [project, session] = path.relative(root, resource).split(path.sep);
	return (
		project !== undefined && session !== undefined && isSessionSegment(session)
	);
}
