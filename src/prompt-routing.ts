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
