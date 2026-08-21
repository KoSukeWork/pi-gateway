/**
 * /resume — list recent Pi session files and let chat pick one.
 * Button callback data is resume:<index> (paths do not fit Telegram/Discord limits).
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { defaultAgentDir } from "./new-session.js";
import {
	formatAge,
	formatSessionPreview,
	readSessionPreview,
	truncateChatMessage,
	type SessionPreview,
} from "./session-preview.js";

export const RESUME_LIST_LIMIT = 8;
export const RESUME_PICK_TTL_MS = 5 * 60 * 1000;

export interface RecentSession {
	sessionFile: string;
	mtimeMs: number;
	preview: SessionPreview;
}

export interface ResumeListOptions {
	agentDir?: string;
	rpcSessionDir?: string;
	limit?: number;
	now?: number;
	boundFile?: string | null;
	activeFile?: string | null;
}

const pendingPicks = new Map<string, { files: string[]; expiresAt: number }>();

export function listRecentSessions(options: ResumeListOptions = {}): RecentSession[] {
	const limit = options.limit ?? RESUME_LIST_LIMIT;
	const files = collectSessionFiles(options.agentDir, options.rpcSessionDir);
	return files.slice(0, limit).map((entry) => ({
		sessionFile: entry.path,
		mtimeMs: entry.mtimeMs,
		preview: readSessionPreview(entry.path),
	}));
}

export function formatResumeList(
	sessions: RecentSession[],
	options: ResumeListOptions = {},
): string {
	const now = options.now ?? Date.now();
	if (sessions.length === 0) {
		return "No session files found to resume.";
	}
	const lines = [
		"Pick a session to resume. Tap a button, or send `/resume 2`.",
		"",
	];
	sessions.forEach((session, i) => {
		const tags: string[] = [];
		if (options.activeFile && sameFile(options.activeFile, session.sessionFile)) {
			tags.push("last desktop");
		}
		if (options.boundFile && sameFile(options.boundFile, session.sessionFile)) {
			tags.push("this chat");
		}
		const tag = tags.length ? ` (${tags.join(", ")})` : "";
		const label = projectLabel(session.preview);
		const when = formatAge(session.mtimeMs, now);
		const you = snippet(session.preview.lastUserText || session.preview.firstUserText);
		lines.push(`${i + 1}. ${label} · ${when}${tag}`);
		lines.push(you ? `   You: ${you}` : "   (no messages yet)");
	});
	return truncateChatMessage(lines.join("\n"));
}

export function resumeButtons(
	sessions: RecentSession[],
): Array<Array<{ text: string; data: string }>> {
	const buttons = sessions.map((session, i) => ({
		text: `${i + 1} ${projectLabel(session.preview)}`.slice(0, 80),
		data: `resume:${i}`,
	}));
	const rows: Array<Array<{ text: string; data: string }>> = [];
	for (let i = 0; i < buttons.length; i += 5) {
		rows.push(buttons.slice(i, i + 5));
	}
	return rows;
}

export function rememberResumeList(
	platform: string,
	channelId: string,
	files: string[],
	now = Date.now(),
): void {
	pendingPicks.set(channelKey(platform, channelId), {
		files: [...files],
		expiresAt: now + RESUME_PICK_TTL_MS,
	});
}

export function takeResumeChoice(
	platform: string,
	channelId: string,
	index0: number,
	now = Date.now(),
): { ok: true; sessionFile: string } | { ok: false; error: string } {
	const key = channelKey(platform, channelId);
	const entry = pendingPicks.get(key);
	if (!entry || entry.expiresAt < now) {
		pendingPicks.delete(key);
		return { ok: false, error: "That resume list expired. Run /resume again." };
	}
	if (!Number.isInteger(index0) || index0 < 0 || index0 >= entry.files.length) {
		return {
			ok: false,
			error: `Pick a number from 1 to ${entry.files.length}.`,
		};
	}
	const sessionFile = entry.files[index0];
	pendingPicks.delete(key);
	return { ok: true, sessionFile };
}

export function buildResumeAttachedMessage(
	sessionFile: string,
	hot = false,
	now = Date.now(),
): string {
	const card = formatSessionPreview(readSessionPreview(sessionFile), now);
	const warning = hot
		? "\n\nWarning: that session file was written in the last 15s. Close the desktop Pi window first or the two sides may race."
		: "";
	return truncateChatMessage(`Resumed this session.\n\n${card}${warning}`);
}

export function parseResumeCallback(text: string): number | null {
	const match = text.trim().match(/^Callback:\s*resume:(\d+)$/i);
	if (!match) return null;
	return Number(match[1]);
}

function collectSessionFiles(
	agentDir = defaultAgentDir(),
	rpcSessionDir?: string,
): Array<{ path: string; mtimeMs: number }> {
	const found: Array<{ path: string; mtimeMs: number }> = [];
	const seen = new Set<string>();
	const add = (file: string) => {
		if (seen.has(file)) return;
		try {
			const st = statSync(file);
			if (!st.isFile()) return;
			seen.add(file);
			found.push({ path: file, mtimeMs: st.mtimeMs });
		} catch {
			// unreadable
		}
	};

	const sessionsRoot = join(agentDir, "sessions");
	if (existsSync(sessionsRoot)) {
		for (const dirent of readdirSync(sessionsRoot, { withFileTypes: true })) {
			if (!dirent.isDirectory()) {
				if (dirent.name.endsWith(".jsonl")) add(join(sessionsRoot, dirent.name));
				continue;
			}
			const dir = join(sessionsRoot, dirent.name);
			for (const name of readdirSync(dir)) {
				if (name.endsWith(".jsonl")) add(join(dir, name));
			}
		}
	}

	if (rpcSessionDir && existsSync(rpcSessionDir)) {
		for (const dirent of readdirSync(rpcSessionDir, { withFileTypes: true })) {
			const path = join(rpcSessionDir, dirent.name);
			if (dirent.isFile() && dirent.name.endsWith(".jsonl")) add(path);
			else if (dirent.isDirectory()) {
				for (const name of readdirSync(path)) {
					if (name.endsWith(".jsonl")) add(join(path, name));
				}
			}
		}
	}

	found.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return found;
}

function projectLabel(preview: SessionPreview): string {
	if (preview.cwd) {
		const base = basename(preview.cwd.replace(/[\\/]+$/, ""));
		if (base) return base;
	}
	return "unknown";
}

function snippet(text: string | undefined): string {
	if (!text) return "";
	const collapsed = text
		.replace(/\s+/g, " ")
		.trim()
		.replace(/&/g, "＆")
		.replace(/</g, "‹")
		.replace(/>/g, "›");
	if (collapsed.length <= 80) return collapsed;
	return `${collapsed.slice(0, 79)}…`;
}

function sameFile(a: string, b: string): boolean {
	return a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
}

function channelKey(platform: string, channelId: string): string {
	return `${platform}:${channelId}`;
}
