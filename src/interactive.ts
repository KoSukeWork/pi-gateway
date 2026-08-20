/**
 * Interactive UI Bridge — bridges pi extension_ui_request events
 * to platform-native interactive prompts (inline keyboards, etc.)
 *
 * Protocol (from pi RPC docs):
 *   Pi emits extension_ui_request on stdout when extensions call
 *   ctx.ui.select(), ctx.ui.confirm(), ctx.ui.input(), etc.
 *   The gateway displays these to the user and sends
 *   extension_ui_response back on pi's stdin.
 *
 * Dialog methods (select/confirm/input/editor) MUST always get a response
 * or Pi's tool_call hangs with no timeout of its own. This module cancels
 * when: send fails, there is no active channel, the user ignores the prompt
 * long enough, or the agent ends.
 */

import type { BaseAdapter } from "./adapters/base.js";
import { logger } from "./logger.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface InteractiveUiRequest {
	type: "extension_ui_request";
	id: string;
	method:
		| "select"
		| "confirm"
		| "input"
		| "editor"
		| "notify"
		| "setStatus"
		| "setWidget"
		| "setTitle"
		| "set_editor_text";
	title: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
	notifyType?: "info" | "warning" | "error";
	timeout?: number;
}

/** Platform-agnostic description of an interactive prompt. */
export interface InteractivePrompt {
	requestId: string;
	method: InteractiveUiRequest["method"];
	title: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
	notifyType?: "info" | "warning" | "error";
}

/** User's response to an interactive prompt. */
export interface InteractiveResponse {
	requestId: string;
	value?: string;
	confirmed?: boolean;
	cancelled?: boolean;
}

export interface ActiveChannel {
	platform: string;
	channelId: string;
	userId?: string;
}

export const DIALOG_UI_METHODS = [
	"select",
	"confirm",
	"input",
	"editor",
] as const;

export type DialogUiMethod = (typeof DIALOG_UI_METHODS)[number];

/** Default wait for a human answer when Pi did not send `timeout`. */
export const DEFAULT_INTERACTIVE_TIMEOUT_MS = 120_000;

export function isDialogUiMethod(method: string): method is DialogUiMethod {
	return (DIALOG_UI_METHODS as readonly string[]).includes(method);
}

// ── State ───────────────────────────────────────────────────────────────────

interface PendingUiRequest {
	requestId: string;
	platform: string;
	channelId: string;
	userId?: string;
	messageId: string;
	adapter: BaseAdapter;
	method: DialogUiMethod;
	options?: string[];
	timeoutHandle?: ReturnType<typeof setTimeout>;
}

const pendingUiRequests = new Map<string, PendingUiRequest>();

/** The channel that triggered the current prompt being processed by pi. */
let activeChannel: ActiveChannel | null = null;

/** Callback to write to pi's stdin. Set by index.ts */
let writeToStdin: ((line: string) => void) | null = null;

/** Set by index.ts — called after a select/confirm response is sent to pi */
export let streamRedirectHandler: (() => void) | null = null;
export function setStreamRedirectHandler(fn: (() => void) | null): void {
	streamRedirectHandler = fn;
}

/** Set by index.ts — called immediately when an extension_ui_request
 * arrives on stdout, to flush full accumulated text into the placeholder
 * before the user sees the interactive prompt. */
export let flushHandler: (() => void) | null = null;
export function setFlushHandler(fn: (() => void) | null): void {
	flushHandler = fn;
}

// ── Public API ──────────────────────────────────────────────────────────────

export function setStdinWriter(fn: (line: string) => void): void {
	writeToStdin = fn;
}

export function setActiveChannel(ch: ActiveChannel | null): void {
	activeChannel = ch;
}

export function getActiveChannel(): ActiveChannel | null {
	return activeChannel;
}

export function pendingUiCount(): number {
	return pendingUiRequests.size;
}

/** Test helper — drop pending state without talking to Pi. */
export function resetInteractiveStateForTests(): void {
	for (const pending of pendingUiRequests.values()) {
		if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
	}
	pendingUiRequests.clear();
	activeChannel = null;
	writeToStdin = null;
	streamRedirectHandler = null;
	flushHandler = null;
}

/**
 * Tell Pi this dialog was cancelled so a tool_call cannot hang.
 * Safe to call if the id is unknown — Pi ignores unmatched responses.
 */
export function cancelUiRequest(requestId: string): void {
	const pending = pendingUiRequests.get(requestId);
	if (pending?.timeoutHandle) clearTimeout(pending.timeoutHandle);
	if (pending) {
		pendingUiRequests.delete(requestId);
		pending.adapter
			.cleanupInteractive?.(pending.channelId, pending.messageId)
			.catch(() => {});
	}
	sendUiResponse(requestId, { requestId, cancelled: true });
}

/**
 * Handle an extension_ui_request event from pi's stdout.
 * Called from the RPC stdout handler in index.ts.
 */
export async function handleExtensionUiRequest(
	msg: InteractiveUiRequest,
	adapter: BaseAdapter,
): Promise<void> {
	if (!activeChannel) {
		logger.warn("[interactive] No active channel — cannot route UI request");
		if (isDialogUiMethod(msg.method)) {
			cancelUiRequest(msg.id);
		}
		return;
	}

	const prompt: InteractivePrompt = {
		requestId: msg.id,
		method: msg.method,
		title: msg.title,
		message: msg.message,
		options: msg.options,
		placeholder: msg.placeholder,
		prefill: msg.prefill,
		notifyType: msg.notifyType,
	};

	// Fire-and-forget methods — display but don't track for response
	const fireAndForget = new Set([
		"notify",
		"setStatus",
		"setWidget",
		"setTitle",
		"set_editor_text",
	]);
	if (fireAndForget.has(msg.method)) {
		try {
			await adapter.sendInteractive(activeChannel.channelId, prompt);
		} catch (err) {
			logger.error(`[interactive] Failed to send ${msg.method}:`, err);
		}
		return;
	}

	// Dialog method — send and track for response
	try {
		const result = await adapter.sendInteractive(
			activeChannel.channelId,
			prompt,
		);
		if (!result?.messageId) {
			logger.error(
				`[interactive] sendInteractive returned no messageId for ${msg.method} — auto-cancelling`,
			);
			cancelUiRequest(msg.id);
			return;
		}
		const timeoutMs =
			msg.timeout && msg.timeout > 0
				? msg.timeout
				: DEFAULT_INTERACTIVE_TIMEOUT_MS;
		const timeoutHandle = setTimeout(() => {
			if (!pendingUiRequests.has(msg.id)) return;
			logger.warn(
				`[interactive] Timed out waiting for ${msg.method} ${msg.id.slice(0, 8)}… after ${timeoutMs}ms`,
			);
			cancelUiRequest(msg.id);
		}, timeoutMs);
		pendingUiRequests.set(msg.id, {
			requestId: msg.id,
			platform: activeChannel.platform,
			channelId: activeChannel.channelId,
			userId: activeChannel.userId,
			messageId: result.messageId,
			adapter,
			method: msg.method as DialogUiMethod,
			options: msg.options,
			timeoutHandle,
		});
		logger.info(
			`[interactive] Sent ${msg.method} prompt ${msg.id.slice(0, 8)}… to ${activeChannel.platform}/${activeChannel.channelId}`,
		);
	} catch (err) {
		logger.error("[interactive] Failed to send interactive prompt:", err);
		cancelUiRequest(msg.id);
	}
}

/**
 * Parse a free-text reply against a pending dialog.
 * Returns null when the text should NOT be consumed (unrelated chatter).
 */
export function parseInteractiveTextReply(
	content: string,
	pending: { method: DialogUiMethod; options?: string[] },
): Omit<InteractiveResponse, "requestId"> | null {
	const text = content.trim();
	if (!text) return null;

	if (pending.method === "select") {
		const options = pending.options ?? [];
		if (/^\d+$/.test(text)) {
			const asNum = parseInt(text, 10);
			if (asNum >= 1 && asNum <= options.length) {
				return { value: String(asNum - 1) };
			}
			return null;
		}
		const exact = options.find(
			(option) => option.toLowerCase() === text.toLowerCase(),
		);
		if (exact) return { value: exact };
		if (/^(y|yes)$/i.test(text)) {
			const yes = options.find((option) => option.toLowerCase() === "yes");
			if (yes) return { value: yes };
		}
		if (/^(n|no)$/i.test(text)) {
			const no = options.find((option) => option.toLowerCase() === "no");
			if (no) return { value: no };
		}
		return null;
	}

	if (pending.method === "confirm") {
		if (/^(y|yes|true|1)$/i.test(text)) return { confirmed: true };
		if (/^(n|no|false|0)$/i.test(text)) return { confirmed: false };
		return null;
	}

	if (pending.method === "input" || pending.method === "editor") {
		return { value: text };
	}

	return null;
}

function latestPendingForChannel(
	platform: string,
	channelId: string,
): PendingUiRequest | undefined {
	let match: PendingUiRequest | undefined;
	for (const pending of pendingUiRequests.values()) {
		if (pending.platform === platform && pending.channelId === channelId) {
			match = pending;
		}
	}
	return match;
}

/**
 * If this channel has a pending dialog and `content` answers it, resolve
 * the dialog and return true so the caller does not treat it as a new prompt.
 */
export function tryConsumeTextReply(
	platform: string,
	channelId: string,
	content: string,
	userId?: string,
): boolean {
	const pending = latestPendingForChannel(platform, channelId);
	if (!pending) return false;
	if (pending.userId && userId && pending.userId !== userId) {
		return false;
	}
	const parsed = parseInteractiveTextReply(content, pending);
	if (!parsed) return false;
	handleInteractiveResponse({ requestId: pending.requestId, ...parsed });
	return true;
}

/**
 * Handle a user's response to an interactive prompt.
 * Called by adapters when the user clicks a button or replies.
 *
 * If requestId is empty, looks up the most recent pending request
 * for the active channel (used for ForceReply responses on Telegram).
 */
export function handleInteractiveResponse(
	response: InteractiveResponse,
	fromUserId?: string,
): void {
	let pending = response.requestId
		? pendingUiRequests.get(response.requestId)
		: undefined;

	// Fallback for ForceReply: if no requestId, find the most recent
	// pending request for the current active channel.
	if (!pending && activeChannel) {
		pending = latestPendingForChannel(
			activeChannel.platform,
			activeChannel.channelId,
		);
		if (pending) response.requestId = pending.requestId;
	}

	if (!pending) {
		logger.warn(
			`[interactive] No pending request for id ${(response.requestId || "(empty)").slice(0, 8)}…`,
		);
		return;
	}

	if (pending.userId && fromUserId && pending.userId !== fromUserId) {
		logger.warn(
			`[interactive] Ignoring response for ${pending.requestId.slice(0, 8)}… from other user ${fromUserId}`,
		);
		return;
	}

	logger.info(
		`[interactive] Response for ${response.requestId.slice(0, 8)}…: ${response.value ?? (response.confirmed ? "confirmed" : "?")}${response.cancelled ? " (cancelled)" : ""}`,
	);

	// Resolve index-based select responses back to option text
	// (telegram/discord use indices in callback_data to stay under size limits)
	if (response.value !== undefined && pending.options) {
		const idx = parseInt(response.value, 10);
		if (
			/^\d+$/.test(response.value) &&
			!isNaN(idx) &&
			idx >= 0 &&
			idx < pending.options.length
		) {
			response.value = pending.options[idx];
		}
	}

	if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
	pendingUiRequests.delete(response.requestId);
	pending.adapter
		.cleanupInteractive?.(pending.channelId, pending.messageId)
		.catch(() => {});
	sendUiResponse(response.requestId, response);

	// Redirect subsequent streaming to a new message after select/confirm
	if (
		streamRedirectHandler &&
		(response.value !== undefined || response.confirmed !== undefined)
	) {
		streamRedirectHandler();
	}
}

/**
 * Clean up all pending interactive prompts.
 * Called on agent_end or when the active channel changes.
 * Cancels any still-open dialog so Pi cannot hang on ctx.ui.select().
 */
export function cleanupPendingUiRequests(): void {
	const ids = [...pendingUiRequests.keys()];
	for (const id of ids) {
		logger.info(`[interactive] Cleaning up pending request ${id.slice(0, 8)}…`);
		cancelUiRequest(id);
	}
}

// ── Internal ────────────────────────────────────────────────────────────────

function sendUiResponse(
	requestId: string,
	response: InteractiveResponse,
): void {
	const payload: Record<string, unknown> = {
		type: "extension_ui_response",
		id: requestId,
	};

	if (response.cancelled) {
		payload.cancelled = true;
	} else if (response.confirmed !== undefined) {
		payload.confirmed = response.confirmed;
	} else {
		payload.value = response.value ?? "";
	}

	const line = JSON.stringify(payload) + "\n";
	if (writeToStdin) {
		writeToStdin(line);
	} else {
		logger.error("[interactive] No stdin writer — cannot send UI response");
	}
}
