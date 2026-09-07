import assert from "node:assert/strict";
import {
	buildDiscordModelPicker,
	DISCORD_MODEL_BACK_ID,
	DISCORD_MODEL_PAGE_SIZE,
	DISCORD_MODEL_PICKER_MAX_ENTRIES,
	DISCORD_MODEL_PICKER_TTL_MS,
	DISCORD_MODEL_SELECT_ID,
	DISCORD_PROVIDER_SELECT_ID,
	formatModelListText,
	getDiscordModelPickerState,
	initialDiscordModelPickerView,
	listDiscordProviders,
	modelListUsesInlineButtons,
	parseModelKey,
	parseDiscordModelPageCustomId,
	parseDiscordProviderPageCustomId,
	rememberDiscordModelPicker,
	resolveDiscordModelSelection,
	resolveDiscordProviderSelection,
} from "../src/model-list.js";

assert.equal(modelListUsesInlineButtons("telegram"), true);
assert.equal(modelListUsesInlineButtons("discord"), false);
assert.equal(modelListUsesInlineButtons("slack"), false);

const text = formatModelListText([
	{ provider: "Work", id: "grok-4.6", name: "Grok 4.6" },
	{ provider: "Work", id: "gpt-5", name: "GPT-5" },
]);
assert.match(text, /^Available models \(2\):/);
assert.match(text, /Work\/grok-4\.6/);
assert.match(text, /\/model provider\/id/);

const catalog = [
	{ provider: "Work", id: "grok-4.6", name: "Grok 4.6" },
	{ provider: "Work", id: "gpt-5", name: "GPT-5" },
	{ provider: "OpenAI", id: "gpt-4.1", name: "GPT-4.1" },
];
assert.deepEqual(listDiscordProviders(catalog), ["Work", "OpenAI"]);
assert.deepEqual(initialDiscordModelPickerView(catalog), {
	provider: null,
	page: 0,
});
assert.deepEqual(initialDiscordModelPickerView(catalog.slice(0, 2)), {
	provider: "Work",
	page: 0,
});

const providers = buildDiscordModelPicker(catalog, { provider: null, page: 0 });
assert.match(providers.content, /across 2 providers/);
assert.equal(providers.components.length, 1);
assert.equal(providers.components[0].components[0].custom_id, DISCORD_PROVIDER_SELECT_ID);
assert.equal(
	(providers.components[0].components[0].options as unknown[]).length,
	2,
);
assert.equal(
	(providers.components[0].components[0].options as Array<{ value: string }>)[0]
		.value,
	"prov:Work",
);

const work = buildDiscordModelPicker(catalog, { provider: "Work", page: 0 });
assert.match(work.content, /^Work models \(2\)/);
assert.equal(work.components[0].components[0].custom_id, DISCORD_MODEL_SELECT_ID);
assert.equal(work.components[1].components[0].custom_id, DISCORD_MODEL_BACK_ID);

const single = buildDiscordModelPicker(catalog.slice(0, 2), {
	provider: "Work",
	page: 0,
});
assert.equal(
	single.components.some((row) =>
		row.components.some((c) => c.custom_id === DISCORD_MODEL_BACK_ID),
	),
	false,
);

const manyWork = Array.from({ length: 60 }, (_, i) => ({
	provider: "Work",
	id: `model-${i}`,
	name: `Model ${i}`,
}));
const manyOpen = Array.from({ length: 3 }, (_, i) => ({
	provider: "Other",
	id: `o-${i}`,
	name: `Other ${i}`,
}));
const paged = buildDiscordModelPicker([...manyWork, ...manyOpen], {
	provider: "Work",
	page: 1,
});
assert.match(paged.content, /Showing 26–50/);
assert.equal(
	(paged.components[0].components[0].options as unknown[]).length,
	DISCORD_MODEL_PAGE_SIZE,
);
assert.equal(paged.components[1].components[0].custom_id, DISCORD_MODEL_BACK_ID);
assert.equal(paged.components[1].components[3].disabled, false);

const longId = "x".repeat(120);
const longPicker = buildDiscordModelPicker(
	[{ provider: "Work", id: longId, name: "Long" }],
	{ provider: "Work", page: 0 },
);
assert.equal(
	(longPicker.components[0].components[0].options as Array<{ value: string }>)[0]
		.value,
	"modelidx:0",
);

assert.equal(
	resolveDiscordModelSelection("model:Work/grok-4.6", catalog),
	"Work/grok-4.6",
);
assert.equal(
	resolveDiscordProviderSelection("prov:OpenAI", ["Work", "OpenAI"]),
	"OpenAI",
);
assert.equal(
	resolveDiscordProviderSelection("providx:1", ["Work", "OpenAI"]),
	"OpenAI",
);

assert.deepEqual(parseDiscordModelPageCustomId("modelpage:2"), {
	page: 2,
	stay: false,
});
assert.deepEqual(parseDiscordProviderPageCustomId("modelprovpage:stay:1"), {
	page: 1,
	stay: true,
});

rememberDiscordModelPicker("chan", "message-1", "user-1", catalog, 1000);
rememberDiscordModelPicker(
	"chan",
	"message-2",
	"user-2",
	[{ provider: "Other", id: "other", name: "Other" }],
	1000,
);
const saved = getDiscordModelPickerState("chan", "message-1", 1000);
assert.equal(saved?.view.provider, null);
assert.equal(saved?.ownerUserId, "user-1");
assert.equal(
	getDiscordModelPickerState("chan", "message-2", 1000)?.models[0].provider,
	"Other",
);
assert.equal(
	getDiscordModelPickerState(
		"chan",
		"message-1",
		1000 + DISCORD_MODEL_PICKER_TTL_MS + 1,
	),
	null,
);

assert.deepEqual(parseModelKey("Work/gpt-5"), {
	provider: "Work",
	modelId: "gpt-5",
});
assert.deepEqual(parseModelKey("Work/openrouter/anthropic/claude"), {
	provider: "Work",
	modelId: "openrouter/anthropic/claude",
});
assert.deepEqual(parseModelKey("MixedCase/Model-ID"), {
	provider: "MixedCase",
	modelId: "Model-ID",
});
assert.equal(parseModelKey("missing-separator"), null);
assert.equal(parseModelKey("Work/"), null);

for (let index = 0; index <= DISCORD_MODEL_PICKER_MAX_ENTRIES; index++) {
	rememberDiscordModelPicker(
		"bounded",
		`message-${index}`,
		"owner",
		catalog,
		2000 + index,
	);
}
assert.equal(
	getDiscordModelPickerState("bounded", "message-0", 3000),
	null,
);
assert.ok(
	getDiscordModelPickerState(
		"bounded",
		`message-${DISCORD_MODEL_PICKER_MAX_ENTRIES}`,
		3000,
	),
);

console.log("model-list tests passed");