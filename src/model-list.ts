import { truncateDiscordLabel } from "./adapters/discord-interactive.js";

export type CatalogModel = {
	provider: string;
	id: string;
	name: string;
};

/** Telegram inline keyboards can list many models; Discord buttons cap at 5x5. */
export function modelListUsesInlineButtons(platform: string): boolean {
	return platform === "telegram";
}

export function formatModelListText(models: CatalogModel[]): string {
	const list = models
		.map((model) => `• ${model.provider}/${model.id} — ${model.name}`)
		.join("\n");
	return `Available models (${models.length}):\n${list}\n\nUse \`/model provider/id\` to switch.`;
}

/** Discord string selects hold 25 options. Provider list and model list both page. */
export const DISCORD_MODEL_PAGE_SIZE = 25;
export const DISCORD_MODEL_PICKER_TTL_MS = 15 * 60 * 1000;
export const DISCORD_MODEL_SELECT_ID = "modelsel";
export const DISCORD_PROVIDER_SELECT_ID = "modelprov";
export const DISCORD_MODEL_BACK_ID = "modelback";

export type DiscordMessageComponent = {
	type: 1;
	components: Array<Record<string, unknown>>;
};

export type DiscordModelPickerMessage = {
	content: string;
	components: DiscordMessageComponent[];
};

export type DiscordModelPickerView = {
	provider: string | null;
	page: number;
};

type PickerEntry = {
	models: CatalogModel[];
	view: DiscordModelPickerView;
	savedAt: number;
};

const discordModelPickers = new Map<string, PickerEntry>();

export function discordModelPickerKey(channelId: string): string {
	return `discord:${channelId}`;
}

export function listDiscordProviders(models: CatalogModel[]): string[] {
	const providers: string[] = [];
	const seen = new Set<string>();
	for (const model of models) {
		if (seen.has(model.provider)) continue;
		seen.add(model.provider);
		providers.push(model.provider);
	}
	return providers;
}

export function modelsForDiscordProvider(
	models: CatalogModel[],
	provider: string,
): CatalogModel[] {
	return models.filter((model) => model.provider === provider);
}

export function initialDiscordModelPickerView(
	models: CatalogModel[],
): DiscordModelPickerView {
	const providers = listDiscordProviders(models);
	if (providers.length === 1) return { provider: providers[0], page: 0 };
	return { provider: null, page: 0 };
}

export function rememberDiscordModelPicker(
	channelId: string,
	models: CatalogModel[],
	now = Date.now(),
): void {
	discordModelPickers.set(discordModelPickerKey(channelId), {
		models: models.slice(),
		view: initialDiscordModelPickerView(models),
		savedAt: now,
	});
}

export function getDiscordModelPickerState(
	channelId: string,
	now = Date.now(),
): PickerEntry | null {
	const entry = discordModelPickers.get(discordModelPickerKey(channelId));
	if (!entry) return null;
	if (now - entry.savedAt > DISCORD_MODEL_PICKER_TTL_MS) {
		discordModelPickers.delete(discordModelPickerKey(channelId));
		return null;
	}
	return entry;
}

export function updateDiscordModelPickerView(
	channelId: string,
	view: DiscordModelPickerView,
	now = Date.now(),
): PickerEntry | null {
	const entry = getDiscordModelPickerState(channelId, now);
	if (!entry) return null;
	entry.view = {
		provider: view.provider,
		page: Math.max(0, view.page),
	};
	return entry;
}

export function discordModelPageCount(total: number): number {
	if (total <= 0) return 1;
	return Math.ceil(total / DISCORD_MODEL_PAGE_SIZE);
}

export function parseDiscordModelPageCustomId(
	customId: string,
): { page: number; stay: boolean } | null {
	if (!customId.startsWith("modelpage:")) return null;
	const rest = customId.slice("modelpage:".length);
	if (rest.startsWith("stay:")) {
		const page = Number(rest.slice("stay:".length));
		if (!Number.isInteger(page)) return null;
		return { page, stay: true };
	}
	const page = Number(rest);
	if (!Number.isInteger(page)) return null;
	return { page, stay: false };
}

export function parseDiscordProviderPageCustomId(
	customId: string,
): { page: number; stay: boolean } | null {
	if (!customId.startsWith("modelprovpage:")) return null;
	const rest = customId.slice("modelprovpage:".length);
	if (rest.startsWith("stay:")) {
		const page = Number(rest.slice("stay:".length));
		if (!Number.isInteger(page)) return null;
		return { page, stay: true };
	}
	const page = Number(rest);
	if (!Number.isInteger(page)) return null;
	return { page, stay: false };
}

export function resolveDiscordModelSelection(
	payload: string,
	models: CatalogModel[] | null,
): string | null {
	if (payload.startsWith("modelidx:")) {
		const index = Number(payload.slice("modelidx:".length));
		const model = Number.isInteger(index) ? models?.[index] : undefined;
		return model ? `${model.provider}/${model.id}` : null;
	}
	if (payload.startsWith("model:")) {
		const key = payload.slice("model:".length).trim();
		return key.includes("/") ? key : null;
	}
	return null;
}

export function resolveDiscordProviderSelection(
	payload: string,
	providers: string[],
): string | null {
	if (payload.startsWith("providx:")) {
		const index = Number(payload.slice("providx:".length));
		return Number.isInteger(index) ? (providers[index] ?? null) : null;
	}
	if (payload.startsWith("prov:")) {
		const name = payload.slice("prov:".length);
		return providers.includes(name) ? name : null;
	}
	return providers.includes(payload) ? payload : null;
}

function modelOptionValue(model: CatalogModel, index: number): string {
	const value = `model:${model.provider}/${model.id}`;
	return value.length <= 100 ? value : `modelidx:${index}`;
}

function providerOptionValue(provider: string, index: number): string {
	const value = `prov:${provider}`;
	return value.length <= 100 ? value : `providx:${index}`;
}

function pageButtons(
	prefix: "modelpage" | "modelprovpage",
	pageIndex: number,
	pageCount: number,
	extra: Record<string, unknown>[] = [],
): DiscordMessageComponent {
	return {
		type: 1,
		components: [
			...extra,
			{
				type: 2,
				style: 2,
				label: "◀ Prev",
				custom_id: `${prefix}:${pageIndex - 1}`,
				disabled: pageIndex === 0,
			},
			{
				type: 2,
				style: 2,
				label: `${pageIndex + 1} / ${pageCount}`,
				custom_id: `${prefix}:stay:${pageIndex}`,
				disabled: true,
			},
			{
				type: 2,
				style: 2,
				label: "Next ▶",
				custom_id: `${prefix}:${pageIndex + 1}`,
				disabled: pageIndex >= pageCount - 1,
			},
		],
	};
}

function buildProviderPicker(
	models: CatalogModel[],
	page: number,
): DiscordModelPickerMessage {
	const providers = listDiscordProviders(models);
	const pageCount = discordModelPageCount(providers.length);
	const pageIndex = Math.min(Math.max(0, page), pageCount - 1);
	const start = pageIndex * DISCORD_MODEL_PAGE_SIZE;
	const slice = providers.slice(start, start + DISCORD_MODEL_PAGE_SIZE);
	const from = slice.length === 0 ? 0 : start + 1;
	const to = start + slice.length;
	const counts = new Map<string, number>();
	for (const model of models) {
		counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
	}

	const components: DiscordMessageComponent[] = [];
	if (slice.length > 0) {
		components.push({
			type: 1,
			components: [
				{
					type: 3,
					custom_id: DISCORD_PROVIDER_SELECT_ID,
					placeholder: truncateDiscordLabel(
						`Select a provider (${from}–${to} of ${providers.length})`,
						150,
					),
					min_values: 1,
					max_values: 1,
					options: slice.map((provider, offset) => {
						const index = start + offset;
						const count = counts.get(provider) ?? 0;
						return {
							label: truncateDiscordLabel(provider, 100),
							value: providerOptionValue(provider, index),
							description: truncateDiscordLabel(
								`${count} model${count === 1 ? "" : "s"}`,
								100,
							),
						};
					}),
				},
			],
		});
	}
	if (pageCount > 1) {
		components.push(pageButtons("modelprovpage", pageIndex, pageCount));
	}

	return {
		content:
			models.length === 0
				? "No models available."
				: `Available models (${models.length}) across ${providers.length} providers.\nPick a provider, or \`/model provider/id\`.`,
		components,
	};
}

function buildModelPicker(
	models: CatalogModel[],
	provider: string,
	page: number,
	showBack: boolean,
): DiscordModelPickerMessage {
	const scoped = modelsForDiscordProvider(models, provider);
	const pageCount = discordModelPageCount(scoped.length);
	const pageIndex = Math.min(Math.max(0, page), pageCount - 1);
	const start = pageIndex * DISCORD_MODEL_PAGE_SIZE;
	const slice = scoped.slice(start, start + DISCORD_MODEL_PAGE_SIZE);
	const from = slice.length === 0 ? 0 : start + 1;
	const to = start + slice.length;

	const components: DiscordMessageComponent[] = [];
	if (slice.length > 0) {
		components.push({
			type: 1,
			components: [
				{
					type: 3,
					custom_id: DISCORD_MODEL_SELECT_ID,
					placeholder: truncateDiscordLabel(
						`Select a ${provider} model (${from}–${to} of ${scoped.length})`,
						150,
					),
					min_values: 1,
					max_values: 1,
					options: slice.map((model, offset) => {
						const index = models.indexOf(model);
						const key = `${model.provider}/${model.id}`;
						return {
							label: truncateDiscordLabel(model.name || model.id, 100),
							value: modelOptionValue(model, index),
							description: truncateDiscordLabel(key, 100),
						};
					}),
				},
			],
		});
	}

	const back = showBack
		? [
				{
					type: 2,
					style: 2,
					label: "◀ Providers",
					custom_id: DISCORD_MODEL_BACK_ID,
				},
			]
		: [];

	if (pageCount > 1) {
		components.push(pageButtons("modelpage", pageIndex, pageCount, back));
	} else if (back.length > 0) {
		components.push({ type: 1, components: back });
	}

	return {
		content:
			scoped.length === 0
				? `No models for ${provider}.`
				: `${provider} models (${scoped.length}). Showing ${from}–${to}.\nPick one, or \`/model provider/id\`.`,
		components,
	};
}

export function buildDiscordModelPicker(
	models: CatalogModel[],
	view: DiscordModelPickerView = initialDiscordModelPickerView(models),
): DiscordModelPickerMessage {
	if (!view.provider) return buildProviderPicker(models, view.page);
	const providers = listDiscordProviders(models);
	return buildModelPicker(
		models,
		view.provider,
		view.page,
		providers.length > 1,
	);
}