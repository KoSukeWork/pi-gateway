import type { PlatformAdapter, PlatformMessage } from "./adapters/base.js";
import { logger } from "./logger.js";
import { truncateDiscordContent, truncateDiscordMarkdown } from "./adapters/discord-interactive.js";

export type ReplyOutcome = "success" | "error" | "stopped";

/** One visible reply for one turn. All edits finish before the final delivery. */
export class ChatReply {
	private messageId?: string;
	private text = "";
	private phase = "⏳ 正在思考…";
	private tools = new Set<string>();
	private waiting = false;
	private stopRequested = false;
	private closed = false;
	private pending: string | null = null;
	private writing: Promise<void> | null = null;
	private editTimer?: ReturnType<typeof setTimeout>;
	private heartbeat?: ReturnType<typeof setInterval>;
	private lastBody = "";
	private startedAt = Date.now();
	private extensionStatuses = new Map<string, string>();
	private extensionDisplayHistory = new Map<string, string>();
	private starting: Promise<void> | null = null;
	private finishing: Promise<void> | null = null;
	private lastFlushedText = "";

	constructor(
		private adapter: PlatformAdapter,
		private message: PlatformMessage,
		private throttleMs = 1200,
	) {}

	start(): Promise<void> {
		return this.starting ??= this.startOnce();
	}

	private async startOnce(): Promise<void> {
		await this.reaction("👀", true);
		try {
			await this.adapter.setTyping(this.message.channelId, true).catch(() => {});
			this.messageId = this.adapter.sendReply
				? await this.adapter.sendReply(this.message, this.render())
				: await this.adapter.sendMessage(this.message.channelId, this.render());
			if (this.closed) return;
			this.heartbeat = setInterval(() => {
				if (!this.waiting) this.adapter.setTyping(this.message.channelId, true).catch(() => {});
				this.schedule();
			}, 4000);
		} catch (error) {
			await this.reaction("👀", false);
			await this.reaction("❌", true);
			throw error;
		}
	}

	stream(text: string): void {
		if (this.closed) return;
		this.text = text;
		if (!this.waiting && !this.tools.size && !this.stopRequested) this.phase = "📝 正在回复…";
		this.schedule();
	}

	async waitForAnswer(): Promise<void> {
		if (this.closed) return;
		this.waiting = true;
		this.phase = "🙋 等待你的回答";
		this.schedule(true);
		// A permission question must not hide the explanation behind a clipped preview.
		const text = this.text;
		if (this.adapter.platform === "discord" && text.length > 1300 && text !== this.lastFlushedText) {
			await this.adapter.sendMessage(this.message.channelId, `📄 提问前的完整回复：\n\n${text}`);
			this.lastFlushedText = text;
		}
	}

	resume(): void {
		if (this.closed) return;
		this.waiting = false;
		if (this.stopRequested) return;
		this.phase = this.tools.size ? "🔧 正在执行工具…" : "⏳ 正在思考…";
		this.schedule(true);
	}

	stopping(): void {
		if (this.closed) return;
		this.waiting = false;
		this.stopRequested = true;
		this.phase = "🛑 正在停止…";
		this.schedule(true);
	}

	event(event: Record<string, any>): void {
		if (this.closed || this.stopRequested) return;
		if (event.type === "tool_execution_start") {
			this.tools.add(String(event.toolCallId ?? event.toolName));
			this.phase = `🔧 正在执行 ${String(event.toolName ?? "工具").slice(0, 80)}…`;
		} else if (event.type === "tool_execution_end") {
			this.tools.delete(String(event.toolCallId ?? event.toolName));
			this.phase = this.tools.size ? "🔧 正在执行工具…" : "⏳ 正在思考…";
		} else if (event.type === "auto_compaction_start" || event.type === "compaction_start") {
			this.phase = "📚 正在整理上下文…";
		} else if (event.type === "auto_retry_start" || event.type === "summarization_retry_scheduled") {
			this.phase = "🔄 正在重试…";
		} else if (event.type === "auto_compaction_end" || event.type === "compaction_end" || event.type === "auto_retry_end" || event.type === "summarization_retry_finished") {
			this.phase = "⏳ 正在思考…";
		} else if (event.type === "extension_ui_request" && event.method === "setStatus") {
			const key = `status:${String(event.statusKey ?? "status")}`;
			if (event.statusText) this.extensionStatuses.set(key, String(event.statusText));
			else this.extensionStatuses.delete(key);
		} else if (event.type === "extension_ui_request" && event.method === "setWidget") {
			const key = `widget:${String(event.widgetKey ?? "widget")}`;
			if (event.widgetLines?.length) this.extensionStatuses.set(key, event.widgetLines.join("\n"));
			else this.extensionStatuses.delete(key);
		} else if (event.type === "extension_ui_request" && event.method === "setTitle") {
			if (event.title) this.extensionStatuses.set("title", String(event.title));
			else this.extensionStatuses.delete("title");
		} else return;
		for (const [key, value] of this.extensionStatuses) this.extensionDisplayHistory.set(key, value);
		this.schedule();
	}

	cancelStop(): void {
		this.stopRequested = false;
		this.resume();
	}

	private render(): string {
		const seconds = Math.floor((Date.now() - this.startedAt) / 1000);
		const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
		const phase = this.waiting ? "🙋 等待你的回答" : this.phase;
		const statuses = [...this.extensionStatuses.values()].slice(0, 3).map((value) => truncateDiscordContent(value.replace(/\n/g, " · "), 160)).join(" · ");
		const footer = `${phase} · ${elapsed}${statuses ? ` · ${statuses}` : ""} · /stop 可停止`;
		const publicText = this.adapter.platform === "discord" ? truncateDiscordMarkdown(this.text, 2000 - footer.length - 6) : this.text;
		return publicText ? `${publicText}\n\n${this.adapter.platform === "discord" ? "-# " : ""}${footer}` : footer;
	}

	private schedule(immediate = false): void {
		if (this.closed || !this.messageId) return;
		if (immediate) {
			clearTimeout(this.editTimer);
			this.editTimer = undefined;
			this.enqueue();
		} else if (!this.editTimer) {
			this.editTimer = setTimeout(() => {
				this.editTimer = undefined;
				this.enqueue();
			}, this.throttleMs);
		}
	}

	private enqueue(): void {
		this.pending = this.render();
		if (this.writing) return;
		this.writing = this.drain().finally(() => {
			this.writing = null;
			if (this.pending !== null && !this.closed) this.enqueue();
		});
	}

	private async drain(): Promise<void> {
		while (this.pending !== null && !this.closed) {
			const body = this.pending;
			this.pending = null;
			if (body === this.lastBody) continue;
			try {
				await this.adapter.editMessage(this.message.channelId, this.messageId!, body, { finalize: false });
				this.lastBody = body;
			} catch (error) {
				logger.warn("[gateway] Reply preview edit failed; final delivery will retry:", error);
			}
		}
	}

	finish(text: string, outcome: ReplyOutcome = "success"): Promise<void> {
		return this.finishing ??= this.finishOnce(text, outcome);
	}

	private async finishOnce(text: string, outcome: ReplyOutcome): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.editTimer);
		clearInterval(this.heartbeat);
		this.pending = null;
		await this.starting?.catch(() => {});
		await this.writing;
		let body = outcome === "stopped"
			? `${text || this.text}${text || this.text ? "\n\n" : ""}🛑 已停止。`
			: outcome === "error"
				? `${this.text}${this.text ? "\n\n" : ""}❌ ${text}`
				: text || this.text || "✅ 本轮已完成，没有文本回复。";
		if (this.extensionDisplayHistory.size) body += "\n\n扩展显示信息：\n" + [...this.extensionDisplayHistory.entries()].map(([key, value]) => `${key}: ${value}`).join("\n\n");
		try {
			const delivery = this.messageId
				? await this.deliverFinal(body)
				: await this.adapter.sendMessage(this.message.channelId, body).then(() => undefined);
			if (delivery?.partial) {
				outcome = "error";
				await this.adapter.sendMessage(this.message.channelId,
					`⚠️ 回复只发送了 ${delivery.deliveredChunks}/${delivery.totalChunks} 段，后续内容发送失败。请检查网关日志。`);
			}
		} catch (error) {
			outcome = "error";
			throw error;
		} finally {
			await this.adapter.setTyping(this.message.channelId, false).catch(() => {});
			await this.reaction("👀", false);
			await this.reaction(outcome === "success" ? "✅" : outcome === "stopped" ? "🛑" : "❌", true);
		}
	}

	private async deliverFinal(body: string) {
		try {
			return await this.adapter.editMessage(this.message.channelId, this.messageId!, body, { finalize: true });
		} catch (error) {
			logger.warn("[gateway] Final reply edit failed, sending a replacement:", error);
			await this.adapter.sendMessage(this.message.channelId, body);
			await this.adapter.deleteMessage(this.message.channelId, this.messageId!).catch(() => {});
		}
	}

	private async reaction(emoji: string, enabled: boolean): Promise<void> {
		if (!this.adapter.setMessageReaction || this.message.metadata?.slashCommand || this.message.metadata?.callback) return;
		await this.adapter.setMessageReaction(this.message.channelId, this.message.id, emoji, enabled).catch((error) => {
			logger.debug("[gateway] Reaction unavailable:", error);
		});
	}
}
