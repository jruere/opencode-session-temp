/**
 * Scratch-root layout: project slug, session segment, and containment (README "Layout").
 *
 * Pure functions only. `resolveLayout` normalizes the root with `path.resolve` and uses the session's own location
 * and project ID; it never reads `os.tmpdir()` or the environment.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { crc32 } from "node:zlib";

const sessionIDPattern = /^ses[A-Za-z0-9._-]+$/;
const base32Alphabet = "abcdefghijklmnopqrstuvwxyz234567";
const maxReadableLength = 48;
const maxSessionPrefixLength = 48;

/** True when `child` is a strict descendant of `parent`, segment-aware. */
export function isInside(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return (
		relative !== "" &&
		relative !== ".." &&
		!relative.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relative)
	);
}

/** Derives the `<project-slug>` segment from a location directory and project ID. */
export function projectSlug(directory: string, projectID: string): string {
	const normalized = path.resolve(directory);
	return `${readableSlug(normalized)}-${slugHash(projectID, normalized)}`;
}

/** True when `segment` is a valid session directory name. */
export function isSessionSegment(segment: string): boolean {
	return sessionIDPattern.test(segment);
}

/** Validates a session ID as a single safe path segment. */
export function sessionSegment(sessionID: string): string {
	if (isSessionSegment(sessionID)) return sessionID;

	const sanitized = sessionID
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "")
		.slice(0, maxSessionPrefixLength)
		.replace(/[-.]+$/g, "");
	const readable = sanitized === "" ? "session" : sanitized;
	const prefixed = readable.startsWith("ses") ? readable : `ses-${readable}`;
	const hash = createHash("sha256")
		.update(sessionID, "utf8")
		.digest("hex")
		.slice(0, 8);
	return `${prefixed}-${hash}`;
}

/** Resolves the per-session scratch layout under `root`. */
export function resolveLayout(
	root: string,
	session: {
		sessionID: string;
		projectID?: string;
		location?: { directory?: string };
	},
): { projectSlug: string; projectDir: string; sessionDir: string } {
	const normalizedRoot = path.resolve(root);
	const segment = sessionSegment(session.sessionID);
	const directory = session.location?.directory;
	const projectID = session.projectID;
	const usable =
		typeof directory === "string" &&
		directory !== "" &&
		typeof projectID === "string" &&
		projectID !== "";

	if (!usable) {
		const projectDir = path.join(normalizedRoot, "global");
		return {
			projectSlug: "global",
			projectDir,
			sessionDir: path.join(projectDir, segment),
		};
	}

	const slug = projectSlug(directory, projectID);
	const projectDir = path.join(normalizedRoot, slug);
	return {
		projectSlug: slug,
		projectDir,
		sessionDir: path.join(projectDir, segment),
	};
}

function readableSlug(normalized: string): string {
	if (normalized === path.parse(normalized).root) return "root";

	const readable = [
		path.basename(path.dirname(normalized)),
		path.basename(normalized),
	]
		.map(slugSegment)
		.filter((segment) => segment !== "")
		.join("_")
		.slice(-maxReadableLength)
		.replace(/^[-_]+|[-_]+$/g, "");

	return readable === "" ? "project" : readable;
}

function slugSegment(segment: string): string {
	return segment
		.replace(/[._\s]/g, "")
		.replace(/[^A-Za-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function slugHash(projectID: string, normalized: string): string {
	const checksum = crc32(Buffer.from(`${projectID}\0${normalized}`, "utf8"));
	const bytes = Buffer.alloc(4);
	bytes.writeUInt32BE(checksum, 0);
	return base32(bytes);
}

function base32(bytes: Uint8Array): string {
	let bits = 0;
	let value = 0;
	let encoded = "";

	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			encoded += base32Alphabet.charAt((value >>> (bits - 5)) & 31);
			bits -= 5;
		}
	}
	if (bits > 0) encoded += base32Alphabet.charAt((value << (5 - bits)) & 31);
	return encoded;
}
