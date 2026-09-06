export type CatalogModel = {
	provider: string;
	id: string;
	name: string;
};

/** Telegram inline keyboards can list many models; Discord caps at 5 rows. */
export function modelListUsesInlineButtons(platform: string): boolean {
	return platform === "telegram";
}

export function formatModelListText(models: CatalogModel[]): string {
	const list = models
		.map((model) => `• ${model.provider}/${model.id} — ${model.name}`)
		.join("\n");
	return `Available models (${models.length}):\n${list}\n\nUse \`/model provider/id\` to switch.`;
}
