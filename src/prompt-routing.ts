/** How a chat message should reach the RPC agent. */
export type ChatPromptRoute = "prompt" | "steer";

/**
 * Mid-run Discord/Telegram text is Pi steer (queue until current tools
 * finish, then inject before the next model call). A new prompt while
 * busy is rejected by RPC and surfaces as a generic gateway error.
 */
export function routeChatMessage(agentBusy: boolean): ChatPromptRoute {
	return agentBusy ? "steer" : "prompt";
}

export function isAgentAlreadyProcessingError(error: unknown): boolean {
	const text = error instanceof Error ? error.message : String(error);
	return /already processing/i.test(text);
}

export function stillWorkingNotice(elapsedMs: number): string {
	const minutes = Math.max(1, Math.round(elapsedMs / 60000));
	return `⏳ 还在处理（已 ${minutes} 分钟）。完成后会发到这条消息里，不用重发。`;
}
