/**
 * Real temporary scratch roots for filesystem tests.
 *
 * `makeTmpRoot` creates a unique directory under the OS temp dir, resolves it with `realpath`, and registers
 * removal with `t.after`. `realpath` matters on macOS, where `/var` is a symlink to `/private/var`, so a lexical
 * containment check would otherwise disagree with the paths the plugin computes.
 *
 * Not covered here: the production default root. Tests never write to it.
 */
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

/** Creates a unique realpathed root and removes it when the test ends. */
export async function makeTmpRoot(t: TestContext): Promise<string> {
	const created = await mkdtemp(path.join(tmpdir(), "opencode-session-temp-"));
	const root = await realpath(created);
	t.after(async () => {
		await rm(root, { recursive: true, force: true });
	});
	return root;
}

/** Creates `<root>/<slug>` and returns it. */
export async function makeProjectDir(
	root: string,
	slug: string,
): Promise<string> {
	const dir = path.join(root, slug);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	return dir;
}

/** Creates `<root>/<slug>/<sessionID>` and returns it. */
export async function makeSessionDir(
	root: string,
	slug: string,
	sessionID: string,
): Promise<string> {
	const dir = path.join(root, slug, sessionID);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	return dir;
}
