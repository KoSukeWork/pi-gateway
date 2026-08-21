import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DETACHED_WORKSPACE_NAME,
	detachedWorkspacePath,
	ensureDetachedWorkspace,
} from "../src/sessions/workspace.ts";

const home = await mkdtemp(join(tmpdir(), "pi-gateway-home-"));
try {
	assert.equal(detachedWorkspacePath(home), join(home, DETACHED_WORKSPACE_NAME));
	const created = ensureDetachedWorkspace(home);
	assert.equal(created, join(home, "pi-gateway-workspace"));
	assert.equal((await stat(created)).isDirectory(), true);
	assert.equal(ensureDetachedWorkspace(home), created);
	console.log("workspace tests passed");
} finally {
	await rm(home, { recursive: true, force: true });
}
