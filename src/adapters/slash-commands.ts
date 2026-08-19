export const DISCORD_SLASH_COMMANDS = [
	{
		name: "continue",
		description: "Attach this chat to the last desktop Pi session",
	},
	{
		name: "session",
		description: "Show the attached desktop session",
	},
	{
		name: "detach",
		description: "Use an isolated gateway session again",
	},
	{
		name: "model",
		description: "List models, or switch with provider/id",
		options: [
			{
				name: "id",
				description: "Model id such as Work/grok-4.6",
				type: 3,
				required: false,
			},
		],
	},
	{
		name: "restart",
		description: "Restart the Pi agent (admin only)",
	},
] as const;

export function slashInteractionToContent(data: {
	name?: string;
	options?: Array<{ name?: string; value?: unknown }>;
}): string | null {
	const name = data.name?.trim().toLowerCase();
	if (!name) return null;
	if (name === "model") {
		const id = data.options?.find((option) => option.name === "id")?.value;
		if (typeof id === "string" && id.trim()) return `/model ${id.trim()}`;
		return "/model";
	}
	if (["continue", "session", "detach", "restart"].includes(name)) {
		return `/${name}`;
	}
	return null;
}
