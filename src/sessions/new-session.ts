/**
 * Create a fresh Pi session jsonl in a chosen working directory.
 * RPC new_session cannot take a cwd, so we write a header and switch_session to it.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { formatSessionPreview, readSessionPreview } from "./session-preview.js";

export type ResolvedCwd =
	| { ok: true; cwd: string }
	| { ok: false; error: string };

export function defaultAgentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR?.trim();
	if (configured) return configured;
	return join(homedir(), ".pi", "agent");
}

/** Match Pi's ~/.pi/agent/sessions/<encoded-cwd>/ directory name. */
export function encodeSessionCwd(cwd: string): string {
	return `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export function sessionDirForCwd(cwd: string, agentDir = defaultAgentDir()): string {
	return join(agentDir, "sessions", encodeSessionCwd(cwd));
}

export function resolveSessionCwd(raw: string, relativeTo = process.cwd()): ResolvedCwd {
	const trimmed = raw.trim();
	if (!trimmed) return { ok: false, error: "Working directory is empty." };

	let expanded = trimmed;
	if (expanded === "~") expanded = homedir();
	else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
		expanded = join(homedir(), expanded.slice(2));
	}

	const cwd = resolve(relativeTo, expanded);
	if (!existsSync(cwd)) {
		return { ok: false, error: `Directory not found: ${cwd}` };
	}
	try {
		if (!statSync(cwd).isDirectory()) {
			return { ok: false, error: `Not a directory: ${cwd}` };
		}
	} catch {
		return { ok: false, error: `Cannot access: ${cwd}` };
	}
	return { ok: true, cwd };
}

export function createProjectSessionFile(
	cwd: string,
	options: { agentDir?: string; now?: Date; id?: string } = {},
): string {
	const now = options.now ?? new Date();
	const id = options.id ?? randomUUID();
	const timestamp = now.toISOString();
	const dir = sessionDirForCwd(cwd, options.agentDir ?? defaultAgentDir());
	mkdirSync(dir, { recursive: true });
	const stamp = timestamp.replace(/[:.]/g, "-");
	const sessionFile = join(dir, `${stamp}_${id}.jsonl`);
	const header = {
		type: "session",
		version: 3,
		id,
		timestamp,
		cwd,
	};
	writeFileSync(sessionFile, `${JSON.stringify(header)}\n`);
	return sessionFile;
}

export function buildNewSessionMessage(opts: {
	sessionFile: string;
	cwd?: string;
	now?: number;
}): string {
	const preview = readSessionPreview(opts.sessionFile);
	if (!preview.cwd && opts.cwd) preview.cwd = opts.cwd;
	return `Started a new conversation.\n\n${formatSessionPreview(preview, opts.now)}`;
}
