import assert from "node:assert/strict";
import {
	buildDiscordInteractiveMessage,
	DISCORD_CONTENT_MAX,
	parseDiscordButtonCustomId,
	truncateDiscordContent,
	truncateDiscordLabel,
} from "../src/adapters/discord-interactive.js";
import { shouldIgnoreDiscordAuthor } from "../src/adapters/discord.js";

assert.equal(truncateDiscordContent("short"), "short");
assert.ok(truncateDiscordContent("x".repeat(5000)).length <= DISCORD_CONTENT_MAX);
assert.ok(truncateDiscordContent("x".repeat(5000)).endsWith("…(truncated)"));
assert.equal(truncateDiscordLabel("Yes"), "Yes");
assert.equal(truncateDiscordLabel("y".repeat(90)).length, 80);

const requestId = "550e8400-e29b-41d4-a716-446655440000";
const select = buildDiscordInteractiveMessage({
	requestId,
	method: "select",
	title: "Permission Required\nAllow rm -rf /tmp/x?",
	options: ["Yes", "Yes, for this session", "No", "No, provide reason"],
});
assert.ok(select.content.includes("Permission Required"));
assert.ok(select.content.includes("1. Yes"));
assert.equal(select.components.length, 1);
assert.equal(select.components[0].components.length, 4);
assert.equal(select.components[0].components[0].style, 3);
assert.equal(select.components[0].components[2].style, 4);
assert.equal(
	select.components[0].components[0].custom_id,
	`ui:s:${requestId}:0`,
);

const parsedYes = parseDiscordButtonCustomId(`ui:s:${requestId}:0`);
assert.deepEqual(parsedYes, { requestId, value: "0" });
const parsedNo = parseDiscordButtonCustomId(`ui:c:${requestId}:0`);
assert.deepEqual(parsedNo, { requestId, confirmed: false });
const parsedConfirm = parseDiscordButtonCustomId(`ui:c:${requestId}:1`);
assert.deepEqual(parsedConfirm, { requestId, confirmed: true });
assert.equal(parseDiscordButtonCustomId("not-a-button"), null);
assert.equal(parseDiscordButtonCustomId("ui:x:abc"), null);

const huge = buildDiscordInteractiveMessage({
	requestId,
	method: "select",
	title: "Permission Required\n" + "A".repeat(4000),
	options: ["Yes", "No"],
});
assert.ok(huge.content.length <= DISCORD_CONTENT_MAX);

const many = buildDiscordInteractiveMessage({
	requestId,
	method: "select",
	title: "Pick",
	options: Array.from({ length: 30 }, (_, i) => `opt-${i}`),
});
assert.equal(many.components.length, 5);
assert.equal(
	many.components.reduce((n, row) => n + row.components.length, 0),
	25,
);
assert.ok(many.content.includes("Showing the first 25"));

const confirm = buildDiscordInteractiveMessage({
	requestId,
	method: "confirm",
	title: "Dangerous command",
	message: "Allow rm?",
});
assert.equal(confirm.components[0].components.length, 2);
assert.deepEqual(parseDiscordButtonCustomId(confirm.components[0].components[0].custom_id), {
	requestId,
	confirmed: true,
});

const input = buildDiscordInteractiveMessage({
	requestId,
	method: "input",
	title: "Share why",
	placeholder: "Reason shown back to the agent",
});
assert.equal(input.components.length, 0);
assert.ok(input.content.includes("Reply with your input"));

assert.equal(
	shouldIgnoreDiscordAuthor({ id: "1539471422685184121", bot: true }, "1539471422685184121"),
	true,
);
assert.equal(
	shouldIgnoreDiscordAuthor({ id: "1539471422685184121", bot: false }, "1539471422685184121"),
	true,
);
assert.equal(
	shouldIgnoreDiscordAuthor({ id: "other-bot", bot: true }, "1539471422685184121"),
	true,
);
assert.equal(
	shouldIgnoreDiscordAuthor({ id: "602673044028129287", bot: false }, "1539471422685184121"),
	false,
);

console.log("discord-interactive tests passed");
