export type ChatSessionCommand =
	| { name: "continue" | "session" | "detach" }
	| { name: "new"; path?: string }
	| { name: "resume"; index?: number };

export function parseChatSessionCommand(text: string): ChatSessionCommand | null {
	const trimmed = text.trim();
	const match = trimmed.match(/^\/(continue|session|detach|new|resume)(?:\s+([\s\S]*))?$/i);
	if (!match) return null;
	const name = match[1].toLowerCase();
	const rest = match[2]?.trim() ?? "";
	if (name === "new") {
		return rest ? { name: "new", path: unquote(rest) } : { name: "new" };
	}
	if (name === "resume") {
		if (/^\d+$/.test(rest)) {
			const index = Number(rest);
			if (index >= 1) return { name: "resume", index };
		}
		return { name: "resume" };
	}
	if (rest) return null;
	return { name: name as "continue" | "session" | "detach" };
}

function unquote(value: string): string {
	if (
		(value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
		(value.startsWith("'") && value.endsWith("'") && value.length >= 2)
	) {
		return value.slice(1, -1);
	}
	return value;
}
