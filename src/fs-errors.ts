/**
 * Filesystem error classifiers shared by the sweep and lifecycle walkers.
 *
 * Scans treat an entry that vanished or lost its parent between scan and action as success. Moves also
 * tolerate a destination that already has the same name, because the caller merges or skips instead of
 * failing the whole move.
 */
/** True for a path that vanished or lost its parent during a scan. */
export function isMissing(error: unknown): boolean {
	const code = errorCode(error);
	return code === "ENOENT" || code === "ENOTDIR";
}

/** True when a directory could not be removed only because it still has children. */
export function isNotEmpty(error: unknown): boolean {
	const code = errorCode(error);
	return code === "ENOTEMPTY" || code === "EEXIST";
}

/** True when a rename failed only because the destination already has the same name. */
export function isDestinationExists(error: unknown): boolean {
	const code = errorCode(error);
	return code === "ENOTEMPTY" || code === "EEXIST" || code === "EISDIR";
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}
