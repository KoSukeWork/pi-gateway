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
}

export interface DiscordActionRow {
	type: 1;
	components: DiscordButton[];
}

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
	if (max <= marker.length) return text.slice(0, max);
	return text.slice(0, max - marker.length) + marker;
}

export function truncateDiscordLabel(
	label: string,
	max = DISCORD_BUTTON_LABEL_MAX,
): string {
	if (label.length <= max) return label;
	if (max <= 1) return label.slice(0, max);
	return `${label.slice(0, max - 1)}…`;
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
		return { requestId, confirmed: rawValue === "1" };
	}
	if (kind === "s") {
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
				label: truncateDiscordLabel(opt),
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
				components: [
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
			return { content: truncateDiscordContent(inputContent(prompt)), components: [] };
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
