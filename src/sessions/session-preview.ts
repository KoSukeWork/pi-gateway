/**
 * Read a Pi session .jsonl just enough to identify it in chat:
 * project, model, first/last user text, last assistant text.
 */

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

export interface SessionPointerLike {
	sessionFile: string;
	sessionId?: string;
	cwd?: string;
	updatedAt?: number;
}

export interface SessionPreview {
	sessionFile: string;
	exists: boolean;
	sessionId?: string;
	cwd?: string;
	startedAt?: string;
	updatedAt?: string;
	model?: string;
	firstUserText?: string;
	lastUserText?: string;
	lastAssistantText?: string;
}

const MAX_FULL_READ = 8 * 1024 * 1024;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;
const SNIPPET_MAX = 200;
export const CHAT_MESSAGE_MAX = 2000;

export function readSessionPreview(sessionFile: string): SessionPreview {
	const preview: SessionPreview = { sessionFile, exists: false };
	if (!sessionFile || !existsSync(sessionFile)) return preview;
	preview.exists = true;

	try {
		const lines = loadJsonlLines(sessionFile);
		for (const line of lines) {
			applySessionEvent(preview, line);
		}
		if (!preview.updatedAt) {
			preview.updatedAt = new Date(statSync(sessionFile).mtimeMs).toISOString();
		}
	} catch {
		try {
			preview.updatedAt = new Date(statSync(sessionFile).mtimeMs).toISOString();
		} catch {
			// file vanished between exists and stat
		}
	}
	return preview;
}

export function formatSessionPreview(
	preview: SessionPreview,
	now = Date.now(),
): string {
	if (!preview.exists) {
		return `Session file not found:\n${preview.sessionFile}`;
	}

	const lines: string[] = [];
	if (preview.cwd) lines.push(`Project: ${preview.cwd}`);

	const updatedMs = preview.updatedAt ? Date.parse(preview.updatedAt) : Number.NaN;
	if (Number.isFinite(updatedMs)) {
		lines.push(`Updated: ${formatAge(updatedMs, now)}`);
	}
	if (preview.model) lines.push(`Model: ${preview.model}`);

	const first = preview.firstUserText?.trim();
	const last = preview.lastUserText?.trim();
	if (first && last && first !== last) {
		lines.push(`Topic: ${oneLine(first, SNIPPET_MAX)}`);
		lines.push(`You: ${oneLine(last, SNIPPET_MAX)}`);
	} else if (last || first) {
		lines.push(`You: ${oneLine(last || first || "", SNIPPET_MAX)}`);
	}
	if (preview.lastAssistantText?.trim()) {
		lines.push(`Pi: ${oneLine(preview.lastAssistantText, SNIPPET_MAX)}`);
	}
	if (preview.sessionId) lines.push(`Session: ${preview.sessionId}`);
	lines.push(`File: ${preview.sessionFile}`);
	return lines.join("\n");
}

export function buildSessionStatusMessage(opts: {
	boundFile?: string | null;
	active?: SessionPointerLike | null;
	now?: number;
}): string {
	const now = opts.now ?? Date.now();
	const boundFile = opts.boundFile || null;
	const active = opts.active ?? null;
	const parts: string[] = [];

	if (boundFile) {
		const sameAsActive = active?.sessionFile === boundFile;
		parts.push(
			sameAsActive
				? `This chat is attached to the last desktop Pi session:\n${cardFor(boundFile, active, now)}`
				: `This chat is attached to:\n${cardFor(boundFile, undefined, now)}`,
		);
		if (active && !sameAsActive) {
			parts.push(`Last desktop Pi session:\n${cardFor(active.sessionFile, active, now)}`);
		}
	} else {
		parts.push("This chat is using an isolated gateway session.");
		parts.push(
			active
				? `Last desktop Pi session:\n${cardFor(active.sessionFile, active, now)}`
				: "No desktop Pi session has been published yet.",
		);
	}

	return truncateChatMessage(parts.join("\n\n"));
}

export function buildContinueMessage(opts: {
	active: SessionPointerLike;
	hot?: boolean;
	now?: number;
}): string {
	const now = opts.now ?? Date.now();
	const card = cardFor(opts.active.sessionFile, opts.active, now);
	const hot = opts.hot
		? "\n\nWarning: that session file was written in the last 15s. Close the desktop Pi window first or the two sides may race."
		: "";
	return truncateChatMessage(`Attached to the last desktop Pi session.\n\n${card}${hot}`);
}

export function formatAge(fromMs: number, now = Date.now()): string {
	const ms = Math.max(0, now - fromMs);
	const sec = Math.round(ms / 1000);
	if (sec < 45) return "just now";
	const min = Math.round(sec / 60);
	if (min < 60) return `${min} min ago`;
	const hr = Math.round(min / 60);
	if (hr < 48) return `${hr} h ago`;
	const day = Math.round(hr / 24);
	return `${day} d ago`;
}

export function truncateChatMessage(text: string, max = CHAT_MESSAGE_MAX): string {
	if (text.length <= max) return text;
	const marker = "\n…(truncated)";
	if (max <= marker.length) return text.slice(0, max);
	return text.slice(0, max - marker.length) + marker;
}

function cardFor(
	sessionFile: string,
	pointer: SessionPointerLike | undefined,
	now: number,
): string {
	const preview = readSessionPreview(sessionFile);
	if (!preview.cwd && pointer?.cwd) preview.cwd = pointer.cwd;
	if (!preview.sessionId && pointer?.sessionId) preview.sessionId = pointer.sessionId;
	if (!preview.updatedAt && pointer?.updatedAt) {
		preview.updatedAt = new Date(pointer.updatedAt).toISOString();
	}
	return formatSessionPreview(preview, now);
}

function loadJsonlLines(sessionFile: string): string[] {
	const size = statSync(sessionFile).size;
	if (size <= MAX_FULL_READ) {
		return readUtf8(sessionFile, 0, size).split(/\r?\n/);
	}

	const head = readUtf8(sessionFile, 0, Math.min(HEAD_BYTES, size));
	const tailStart = Math.max(0, size - TAIL_BYTES);
	const tail = readUtf8(sessionFile, tailStart, size - tailStart);
	const headLines = head.split(/\r?\n/);
	const tailLines = tail.split(/\r?\n/);
	if (headLines.length) headLines.pop();
	if (tailLines.length) tailLines.shift();
	return [...headLines, ...tailLines];
}

function readUtf8(sessionFile: string, position: number, length: number): string {
	if (length <= 0) return "";
	const buf = Buffer.alloc(length);
	const fd = openSync(sessionFile, "r");
	try {
		const n = readSync(fd, buf, 0, length, position);
		return buf.subarray(0, n).toString("utf8");
	} finally {
		closeSync(fd);
	}
}

function applySessionEvent(preview: SessionPreview, line: string): void {
	const trimmed = line.trim();
	if (!trimmed) return;
	let ev: Record<string, unknown>;
	try {
		ev = JSON.parse(trimmed) as Record<string, unknown>;
	} catch {
		return;
	}
	if (!ev || typeof ev !== "object") return;

	if (ev.type === "session") {
		if (typeof ev.id === "string" && ev.id) preview.sessionId = ev.id;
		if (typeof ev.cwd === "string" && ev.cwd) preview.cwd = ev.cwd;
		if (typeof ev.timestamp === "string" && ev.timestamp) preview.startedAt = ev.timestamp;
		return;
	}

	if (ev.type === "model_change") {
		const provider = ev.provider;
		const modelId = ev.modelId;
		if (typeof provider === "string" && typeof modelId === "string") {
			preview.model = `${provider}/${modelId}`;
		}
		return;
	}

	if (ev.type !== "message" || !ev.message || typeof ev.message !== "object") return;
	const message = ev.message as Record<string, unknown>;
	if (typeof ev.timestamp === "string" && ev.timestamp) preview.updatedAt = ev.timestamp;

	const role = message.role;
	if (role === "user") {
		const text = extractText(message.content);
		if (!text) return;
		if (!preview.firstUserText) preview.firstUserText = text;
		preview.lastUserText = text;
		return;
	}
	if (role === "assistant") {
		const text = extractText(message.content);
		if (text) preview.lastAssistantText = text;
		if (typeof message.provider === "string" && typeof message.model === "string") {
			preview.model = `${message.provider}/${message.model}`;
		}
	}
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const rec = block as Record<string, unknown>;
		if (rec.type === "text" && typeof rec.text === "string" && rec.text.trim()) {
			parts.push(rec.text);
		}
	}
	return parts.join("\n").trim();
}

function oneLine(text: string, max: number): string {
	const collapsed = sanitizeChatSnippet(text.replace(/\s+/g, " ").trim());
	if (collapsed.length <= max) return collapsed;
	if (max <= 1) return collapsed.slice(0, max);
	return `${collapsed.slice(0, max - 1)}…`;
}

/**
 * Telegram sendMessage uses HTML parse_mode. Replace markup characters with
 * lookalikes so Discord still shows readable code snippets.
 */
function sanitizeChatSnippet(text: string): string {
	return text.replace(/&/g, "＆").replace(/</g, "‹").replace(/>/g, "›");
}
