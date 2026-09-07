import assert from "node:assert/strict";
import { DiscordAdapter } from "../src/adapters/discord.js";
import {
	DISCORD_MODEL_PICKER_TTL_MS,
	getDiscordModelPickerState,
	rememberDiscordModelPicker,
} from "../src/model-list.js";

const catalog = [
	{ provider: "Work", id: "openrouter/anthropic/claude", name: "Claude" },
	{ provider: "OpenAI", id: "gpt-5", name: "GPT-5" },
];

function interaction(options: {
	messageId: string;
	userId: string;
	customId: string;
	values?: string[];
}) {
	return {
		id: `interaction-${options.messageId}`,
		token: "token",
		channel_id: "channel",
		message: { id: options.messageId },
		member: { user: { id: options.userId } },
		data: {
			custom_id: options.customId,
			values: options.values ?? [],
		},
	};
}

const adapter = new DiscordAdapter({
	platform: "discord",
	botToken: "test",
	enabled: true,
});
const acknowledgements: Array<{ type: number; data?: Record<string, unknown> }> = [];
const callbacks: string[] = [];
(adapter as any).ackInteraction = async (
	_data: unknown,
	payload: { type: number; data?: Record<string, unknown> },
) => {
	acknowledgements.push(payload);
};
(adapter as any).emitCallback = async (_data: unknown, customId: string) => {
	callbacks.push(customId);
};

rememberDiscordModelPicker("channel", "owned", "owner", catalog);
await (adapter as any).handleModelPickerInteraction(
	interaction({
		messageId: "owned",
		userId: "other-user",
		customId: "modelprov",
		values: ["prov:Work"],
	}),
);
assert.equal(acknowledgements.at(-1)?.type, 4);
assert.equal(acknowledgements.at(-1)?.data?.flags, 64);
assert.equal(getDiscordModelPickerState("channel", "owned")?.view.provider, null);

await (adapter as any).handleModelPickerInteraction(
	interaction({
		messageId: "owned",
		userId: "owner",
		customId: "modelprov",
		values: ["prov:Work"],
	}),
);
assert.equal(acknowledgements.at(-1)?.type, 7);
assert.match(String(acknowledgements.at(-1)?.data?.content), /^Work models/);
assert.equal(getDiscordModelPickerState("channel", "owned")?.view.provider, "Work");

await (adapter as any).handleModelPickerInteraction(
	interaction({
		messageId: "owned",
		userId: "owner",
		customId: "modelsel",
		values: ["model:Work/openrouter/anthropic/claude"],
	}),
);
assert.equal(callbacks.at(-1), "model:Work/openrouter/anthropic/claude");
assert.equal(getDiscordModelPickerState("channel", "owned"), null);

rememberDiscordModelPicker(
	"channel",
	"expired",
	"owner",
	catalog,
	Date.now() - DISCORD_MODEL_PICKER_TTL_MS - 1,
);
await (adapter as any).handleModelPickerInteraction(
	interaction({
		messageId: "expired",
		userId: "owner",
		customId: "modelsel",
		values: ["model:Work/openrouter/anthropic/claude"],
	}),
);
assert.match(String(acknowledgements.at(-1)?.data?.content), /expired/i);
assert.equal(callbacks.length, 1);

rememberDiscordModelPicker("channel", "first", "owner", catalog);
rememberDiscordModelPicker(
	"channel",
	"second",
	"owner",
	[{ provider: "Other", id: "other", name: "Other" }],
);
await (adapter as any).handleModelPickerInteraction(
	interaction({
		messageId: "first",
		userId: "owner",
		customId: "modelprov",
		values: ["prov:OpenAI"],
	}),
);
assert.equal(getDiscordModelPickerState("channel", "first")?.view.provider, "OpenAI");
assert.equal(getDiscordModelPickerState("channel", "second")?.view.provider, "Other");

console.log("discord model picker tests passed");
