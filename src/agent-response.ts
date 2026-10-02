/** Rebuild public assistant text from RPC snapshots, excluding reasoning/tool output. */
export function assistantText(message: Record<string, any>): string {
	if (message?.role !== "assistant") return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content.filter((block: any) => block.type === "text" && typeof block.text === "string")
		.map((block: any) => block.text).join("");
}

export function agentEndText(event: Record<string, any>, fallback = ""): string {
	let text = (event.messages ?? []).map(assistantText).filter((text: string) => text.trim()).join("\n\n");
	if (!text || (fallback.length > text.length && fallback.endsWith(text))) text = fallback || text;
	const limited = (event.messages ?? []).some((message: any) => message.role === "assistant" && message.stopReason === "length");
	return text + (limited ? "\n\n⚠️ 模型达到输出长度限制，回复可能未完成。可以要求继续。" : "");
}

export function agentEndError(event: Record<string, any>): string | null {
	const last = [...(event.messages ?? [])].reverse().find((message: any) => message.role === "assistant");
	return last?.stopReason === "error" ? String(last.errorMessage || "模型请求失败，请稍后重试。") : null;
}

export class AssistantStream {
	private completed: string[] = [];
	private current = "";

	get text(): string { return [...this.completed, this.current].filter(Boolean).join("\n\n"); }

	consume(event: Record<string, any>): string | null {
		if (event.type === "message_start" && event.message?.role === "assistant") {
			if (this.current) this.completed.push(this.current);
			this.current = assistantText(event.message);
		} else if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
			this.current = assistantText(event.message) || this.current + (event.assistantMessageEvent.delta ?? "");
		} else if (event.type === "message_end" && event.message?.role === "assistant") {
			this.current = assistantText(event.message) || this.current;
		} else return null;
		return [...this.completed, this.current].filter(Boolean).join("\n\n");
	}
}
