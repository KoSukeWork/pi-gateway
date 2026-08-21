export const DISCORD_SLASH_COMMANDS = [
	{
		name: "continue",
		description: "Attach this chat to the last desktop Pi session",
	},
	{
		name: "session",
		description: "Show project, last messages, and attached session",
	},
	{
		name: "detach",
		description: "Use an isolated gateway session again",
	},
	{
		name: "resume",
		description: "Pick a recent session to continue",
		options: [
			{
				name: "n",
				description: "List number from /resume",
				type: 4,
				required: false,
			},
		],
	},
	{
		name: "new",
		description: "Start a fresh conversation, optionally in a folder",
		options: [
			{
				name: "path",
				description: "Working directory for the new session",
				type: 3,
				required: false,
			},
		],
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
	if (name === "new") {
		const path = data.options?.find((option) => option.name === "path")?.value;
		if (typeof path === "string" && path.trim()) return `/new ${path.trim()}`;
		return "/new";
	}
	if (name === "resume") {
		const n = data.options?.find((option) => option.name === "n")?.value;
		if (typeof n === "number" && n >= 1) return `/resume ${n}`;
		if (typeof n === "string" && /^\d+$/.test(n.trim())) return `/resume ${n.trim()}`;
		return "/resume";
	}
	if (["continue", "session", "detach", "restart"].includes(name)) {
		return `/${name}`;
	}
	return null;
}
