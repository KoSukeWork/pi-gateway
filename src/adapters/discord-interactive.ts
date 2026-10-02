/**
 * Pure Discord interactive-prompt helpers.
 * Kept out of the adapter so payload/custom_id parsing can be unit-tested
 * without a WebSocket or bot token.
 */

import type { InteractivePrompt, InteractiveResponse } from "./base.js";

export const DISCORD_CONTENT_MAX = 2000;
export const DISCORD_BUTTON_LABEL_MAX = 80;
export const DISCORD_CUSTOM_ID_MAX = 100;
export const DISCORD_BUTTONS_PER_ROW = 5;
export const DISCORD_MAX_ACTION_ROWS = 5;

export interface DiscordButton {
	type: 2;
	style: number;
	label: string;
	custom_id: string;
	disabled?: boolean;
}

export interface DiscordStringSelectOption {
	label: string;
	value: string;
	description?: string;
}

export interface DiscordStringSelect {
	type: 3;
	custom_id: string;
	placeholder?: string;
	min_values?: number;
	max_values?: number;
	options: DiscordStringSelectOption[];
	disabled?: boolean;
}

export type DiscordActionRow = {
	type: 1;
	components: DiscordButton[];
} | {
	type: 1;
	components: [DiscordStringSelect];
};

export interface DiscordInteractiveMessage {
	content: string;
	components: DiscordActionRow[];
}

const BUTTON_PRIMARY = 1;
const BUTTON_SECONDARY = 2;
const BUTTON_SUCCESS = 3;
const BUTTON_DANGER = 4;

export function truncateDiscordContent(
	text: string,
	max = DISCORD_CONTENT_MAX,
): string {
	if (text.length <= max) return text;
	const marker = "\n…(truncated)";
	if (max <= marker.length) return safeSlice(text, max);
	return safeSlice(text, max - marker.length) + marker;
}

function safeSlice(text: string, end: number): string {
	const previous = text.charCodeAt(end - 1);
	const next = text.charCodeAt(end);
	return text.slice(0, previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? end - 1 : end);
}

interface CodeFence { marker: string; opener: string }
function updateCodeFence(match: RegExpMatchArray, current: CodeFence | null): CodeFence | null {
	if (!current) {
		if (match[1][0] === "`" && match[2].includes("`")) return null;
		return { marker: match[1], opener: match[0] };
	}
	return match[1][0] === current.marker[0] && match[1].length >= current.marker.length && !match[2].trim() ? null : current;
}
function fenceMatches(text: string): RegExpMatchArray[] {
	return [...text.matchAll(/^ {0,3}(`{3,}|~{3,})([^\n]*)$/gm)];
}
function openCodeFence(text: string): CodeFence | null {
	let current: CodeFence | null = null;
	for (const match of fenceMatches(text)) current = updateCodeFence(match, current);
	return current;
}

/** Keep live status text outside an unfinished code block. */
export function truncateDiscordMarkdown(text: string, max = DISCORD_CONTENT_MAX): string {
	const reserve = Math.max(4, ...fenceMatches(text).map((match) => match[1].length + 1));
	if (reserve >= max) return truncateDiscordContent(text, max);
	const preview = truncateDiscordContent(text, max - reserve);
	const fence = openCodeFence(preview);
	return fence ? `${preview}\n${fence.marker}` : preview;
}

/**
 * Split a Discord message into <=max chunks, preferring newline then space.
 * Empty / whitespace-only input yields no chunks (Discord rejects "").
 */
function splitPlainContent(
	text: string,
	max = DISCORD_CONTENT_MAX,
	protectedLines: Array<{ start: number; end: number }> = [],
): string[] {
	if (max < 1) return text ? [text] : [];
	const normalized = text.replace(/\r\n/g, "\n");
	if (!normalized.trim()) return [];
	if (normalized.length <= max) return [normalized];
	const chunks: string[] = [];
	let rest = normalized;
	const minCut = Math.floor(max * 0.4);
	while (rest.length > max) {
		const window = rest.slice(0, max);
		let cut = window.lastIndexOf("\n");
		let skipDelimiter = cut >= minCut;
		if (cut < minCut) {
			cut = window.lastIndexOf(" ");
			skipDelimiter = cut >= minCut;
		}
		if (cut < minCut) {
			cut = max;
			skipDelimiter = false;
		}
		cut = safeSlice(rest, cut).length;
		if (cut === 0) cut = Math.min(2, rest.length);
		if (skipDelimiter) cut += 1;
		const offset = normalized.length - rest.length;
		const line = protectedLines.find((range) => range.start < offset + cut && range.end > offset + cut);
		if (line) cut = line.start > offset ? line.start - offset : line.end - offset;
		const chunk = rest.slice(0, cut);
		if (chunk) chunks.push(chunk);
		rest = rest.slice(cut);
	}
	if (rest) chunks.push(rest);
	return chunks;
}

/** Close/reopen fenced code across final messages, preserving its language. */
export function splitDiscordContent(text: string, max = DISCORD_CONTENT_MAX): string[] {
	const normalized = text.replace(/\r\n/g, "\n");
	const matches = fenceMatches(normalized);
	if (max < 100 || !matches.length || normalized.length <= max) return splitPlainContent(normalized, max);
	const reserve = Math.max(...matches.map((match) => match[0].length + match[1].length + 2));
	const budget = max - reserve;
	const lines = matches.map((match) => ({ start: match.index!, end: match.index! + match[0].length + (normalized[match.index! + match[0].length] === "\n" ? 1 : 0) }));
	if (budget < 2 || lines.some((line) => line.end - line.start > budget)) return splitPlainContent(normalized, max);
	let fence: CodeFence | null = null;
	let offset = 0;
	return splitPlainContent(normalized, budget, lines).map((chunk) => {
		const prefix = fence ? `${fence.opener}\n` : "";
		for (const match of matches) {
			if (match.index! >= offset && match.index! < offset + chunk.length) fence = updateCodeFence(match, fence);
		}
		offset += chunk.length;
		return `${prefix}${chunk}${fence ? `\n${fence.marker}` : ""}`;
	});
}

/** Discord 429 `retry_after` is seconds. Returns null when the status is not 429. */
export function discordRetryAfterMs(status: number, body: string): number | null {
	if (status !== 429) return null;
	try {
		const parsed = JSON.parse(body) as { retry_after?: unknown };
		if (typeof parsed.retry_after === "number" && Number.isFinite(parsed.retry_after)) {
			return Math.min(Math.max(Math.ceil(parsed.retry_after * 1000) + 50, 50), 2_147_483_647);
		}
	} catch {
		// use fallback
	}
	return 500;
}

export function truncateDiscordLabel(
	label: string,
	max = DISCORD_BUTTON_LABEL_MAX,
): string {
	if (label.length <= max) return label;
	if (max <= 1) return safeSlice(label, max);
	return `${safeSlice(label, max - 1)}…`;
}

export function discordButtonCustomId(
	kind: "s" | "c",
	requestId: string,
	value: string,
): string {
	return `ui:${kind}:${requestId}:${value}`;
}

/**
 * Parse `ui:s:<requestId>:<index>` / `ui:c:<requestId>:1|0`.
 * requestId is a UUID (no colons); extra colons stay in the value.
 */
export function parseDiscordButtonCustomId(
	customId: string,
): InteractiveResponse | null {
	if (!customId.startsWith("ui:")) return null;
	const parts = customId.split(":");
	if (parts.length < 4) return null;
	const kind = parts[1];
	const requestId = parts[2];
	const rawValue = parts.slice(3).join(":");
	if (!requestId) return null;
	if (kind === "c") {
		if (rawValue !== "0" && rawValue !== "1") return null;
		return { requestId, confirmed: rawValue === "1" };
	}
	if (kind === "s") {
		if (!/^\d+$/.test(rawValue)) return null;
		return { requestId, value: rawValue };
	}
	return null;
}

function buttonStyleForLabel(label: string): number {
	const lower = label.trim().toLowerCase();
	if (
		lower === "yes" ||
		lower.startsWith("yes,") ||
		lower === "✅ yes" ||
		lower.startsWith("✅")
	) {
		return BUTTON_SUCCESS;
	}
	if (
		lower === "no" ||
		lower.startsWith("no,") ||
		lower === "❌ no" ||
		lower.startsWith("❌")
	) {
		return BUTTON_DANGER;
	}
	if (lower.includes("session") || lower.includes("this session")) {
		return BUTTON_PRIMARY;
	}
	return BUTTON_SECONDARY;
}

function numberedOptions(options: string[]): string {
	return options.map((opt, i) => `${i + 1}. ${opt}`).join("\n");
}

function selectContent(prompt: InteractivePrompt, options: string[]): string {
	const listed = numberedOptions(options);
	const extra =
		options.length > DISCORD_BUTTONS_PER_ROW * DISCORD_MAX_ACTION_ROWS
			? `\n\nShowing the first ${DISCORD_BUTTONS_PER_ROW * DISCORD_MAX_ACTION_ROWS} as buttons. Reply with the number of your choice.`
			: "\n\nTap a button, or reply with the number.";
	return `${prompt.title}\n\n${listed}${extra}`;
}

function confirmContent(prompt: InteractivePrompt): string {
	return prompt.message
		? `${prompt.title}\n\n${prompt.message}\n\nTap Yes / No, or reply yes or no.`
		: `${prompt.title}\n\nTap Yes / No, or reply yes or no.`;
}

function inputContent(prompt: InteractivePrompt): string {
	const hint = prompt.placeholder ? `\n(${prompt.placeholder})` : "";
	const prefill = prompt.prefill ? `\n\n\`\`\`\n${prompt.prefill}\n\`\`\`` : "";
	const kind = prompt.method === "editor" ? "text" : "input";
	return `${prompt.title}${hint}${prefill}\n\nReply with your ${kind}.`;
}

function notifyContent(prompt: InteractivePrompt): string {
	const text = prompt.message || prompt.title;
	if (!text) return "";
	const icon =
		prompt.notifyType === "warning"
			? "⚠️"
			: prompt.notifyType === "error"
				? "❌"
				: "ℹ️";
	return `${icon} ${text}`;
}

function chunkButtons(buttons: DiscordButton[]): DiscordActionRow[] {
	const rows: DiscordActionRow[] = [];
	for (let i = 0; i < buttons.length; i += DISCORD_BUTTONS_PER_ROW) {
		if (rows.length >= DISCORD_MAX_ACTION_ROWS) break;
		rows.push({
			type: 1,
			components: buttons.slice(i, i + DISCORD_BUTTONS_PER_ROW),
		});
	}
	return rows;
}

function selectButtons(
	requestId: string,
	options: string[],
): DiscordButton[] {
	const max = DISCORD_BUTTONS_PER_ROW * DISCORD_MAX_ACTION_ROWS;
	return options.slice(0, max).flatMap((opt, i) => {
		const custom_id = discordButtonCustomId("s", requestId, String(i));
		if (custom_id.length > DISCORD_CUSTOM_ID_MAX) return [];
		return [
			{
				type: 2 as const,
				style: buttonStyleForLabel(opt),
				label: truncateDiscordLabel(opt || "(empty option)"),
				custom_id,
			},
		];
	});
}

/** Build a Discord create-message body for an extension UI prompt. */
export function buildDiscordInteractiveMessage(
	prompt: InteractivePrompt,
): DiscordInteractiveMessage {
	switch (prompt.method) {
		case "select": {
			const options = prompt.options ?? [];
			const content = truncateDiscordContent(selectContent(prompt, options));
			return {
				content,
				components: chunkButtons(selectButtons(prompt.requestId, options)),
			};
		}
		case "confirm": {
			const yesId = discordButtonCustomId("c", prompt.requestId, "1");
			const noId = discordButtonCustomId("c", prompt.requestId, "0");
			return {
				content: truncateDiscordContent(confirmContent(prompt)),
				components: yesId.length > DISCORD_CUSTOM_ID_MAX || noId.length > DISCORD_CUSTOM_ID_MAX ? [] : [
					{
						type: 1,
						components: [
							{
								type: 2,
								style: BUTTON_SUCCESS,
								label: "✅ Yes",
								custom_id: yesId,
							},
							{
								type: 2,
								style: BUTTON_DANGER,
								label: "❌ No",
								custom_id: noId,
							},
						],
					},
				],
			};
		}
		case "input":
		case "editor":
			return { content: truncateDiscordContent(inputContent(prompt)), components: prompt.requestId.length <= 90 ? [{ type: 1, components: [{ type: 2, style: BUTTON_PRIMARY, label: "填写回答", custom_id: `ui:i:${prompt.requestId}` }] }] : [] };
		case "notify":
		case "setStatus":
		case "setWidget":
		case "setTitle":
		case "set_editor_text":
			return { content: truncateDiscordContent(notifyContent(prompt)), components: [] };
		default:
			return {
				content: truncateDiscordContent(
					`${prompt.title}${prompt.message ? `\n\n${prompt.message}` : ""}\n\nReply with your response.`,
				),
				components: [],
			};
	}
}

export function buildDiscordInputModal(prompt: InteractivePrompt): Record<string, unknown> {
	if ((prompt.prefill?.length ?? 0) > 4000) throw new Error("Discord modal cannot preserve a prefill longer than 4000 characters");
	return {
		custom_id: `ui:input:${prompt.requestId}`,
		title: truncateDiscordLabel(prompt.title || "填写回答", 45),
		components: [{ type: 1, components: [{
			type: 4,
			custom_id: "answer",
			label: prompt.method === "editor" ? "编辑内容" : "你的回答",
			style: 2,
			required: false,
			max_length: 4000,
			...(prompt.placeholder ? { placeholder: truncateDiscordLabel(prompt.placeholder, 100) } : {}),
			...(prompt.prefill ? { value: prompt.prefill } : {}),
		}] }],
	};
}
