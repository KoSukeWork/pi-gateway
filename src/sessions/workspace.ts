/**
 * Detached gateway default working directory: ~/pi-gateway-workspace
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DETACHED_WORKSPACE_NAME = "pi-gateway-workspace";

export function detachedWorkspacePath(home = homedir()): string {
	return join(home, DETACHED_WORKSPACE_NAME);
}

export function ensureDetachedWorkspace(home = homedir()): string {
	const dir = detachedWorkspacePath(home);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	return dir;
}
