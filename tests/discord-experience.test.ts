import assert from "node:assert/strict";
import { DiscordAdapter } from "../src/adapters/discord.js";
import { handleExtensionUiRequest, handleInteractiveResponse, resetInteractiveStateForTests, setActiveChannel, setStdinWriter, interactiveResponseStatus, cancelUiRequest, pendingUiCount } from "../src/interactive.js";
import { buildDiscordInputModal, splitDiscordContent, truncateDiscordMarkdown } from "../src/adapters/discord-interactive.js";

function fakeDiscord() {
	const adapter = new DiscordAdapter({ enabled: true, platform: "discord", botToken: "test" });
	const requests: Array<{ endpoint: string; method: string; body: any }> = [];
	let id = 0;
	(adapter as any).apiRequest = async (endpoint: string, options: RequestInit = {}) => {
		requests.push({ endpoint, method: String(options.method), body: options.body ? JSON.parse(String(options.body)) : undefined });
		return new Response(JSON.stringify({ id: `sent-${++id}` }), { status: 200 });
	};
	return { adapter, requests };
}

// Mid-stream oversized previews remain one message and deduplicate saturated text.
{
	const { adapter, requests } = fakeDiscord();
	await adapter.editMessage("c", "m", "x".repeat(4500), { finalize: false });
	await adapter.editMessage("c", "m", "x".repeat(5000), { finalize: false });
	assert.equal(requests.length, 1);
	assert.equal(requests[0].method, "PATCH");
	assert.ok(requests[0].body.content.length <= 2000);
	await adapter.editMessage("c", "m", "x".repeat(4500), { finalize: true });
	assert.deepEqual(requests.map((r) => r.method), ["PATCH", "PATCH", "POST", "POST"]);
	await adapter.editMessage("c", "m", "y".repeat(4500));
	assert.deepEqual(requests.slice(-3).map((r) => r.method), ["PATCH", "PATCH", "PATCH"]);
	assert.ok(requests.every((r) => r.body.allowed_mentions.parse.length === 0));
}

// Slash replies edit Discord's deferred original, including selectors. No permanent spinner.
{
	const { adapter, requests } = fakeDiscord();
	(adapter as any).callbacks = { onMessage: async () => { await adapter.sendModelPicker("c", "u", [{ provider: "P", id: "m", name: "Model" }]); } };
	await (adapter as any).handleInteraction({ type: 2, id: "slash", token: "token", application_id: "app", channel_id: "c", user: { id: "u" }, data: { name: "model" } });
	assert.equal(requests[0].body.type, 5);
	assert.equal(requests[1].endpoint, "/webhooks/app/token/messages/@original");
	assert.equal(requests[1].method, "PATCH");
	assert.ok(requests[1].body.components.length > 0);
	(adapter as any).callbacks = { onMessage: async () => {} };
	await (adapter as any).handleInteraction({ type: 2, id: "slash2", token: "token2", application_id: "app", channel_id: "c", user: { id: "u" }, data: { name: "help" } });
	assert.match(requests.at(-1)!.body.content, /指令已处理/);
}

// Another user's click cannot erase permission buttons. A stale id cannot answer a newer dialog.
{
	resetInteractiveStateForTests();
	const { adapter, requests } = fakeDiscord();
	const lines: string[] = [];
	setStdinWriter((line) => lines.push(line));
	setActiveChannel({ platform: "discord", channelId: "c", userId: "owner" });
	(adapter as any).callbacks = { onInteractiveResponse: handleInteractiveResponse };
	await handleExtensionUiRequest({ type: "extension_ui_request", id: "q", method: "confirm", title: "Permission", message: "Allow?" }, adapter);
	const messageId = "sent-1";
	const button = (userId: string, requestId = "q") => ({ type: 3, id: "click", token: "token", channel_id: "c", user: { id: userId }, message: { id: messageId }, data: { custom_id: `ui:c:${requestId}:1` } });
	await (adapter as any).handleInteraction(button("other"));
	assert.equal(requests.at(-1)!.body.type, 4);
	assert.equal(requests.at(-1)!.body.data.flags, 64);
	assert.equal(lines.length, 0);
	assert.equal(interactiveResponseStatus("q", "discord", "c", "owner", messageId), "valid");
	handleInteractiveResponse({ requestId: "unknown-old-id", confirmed: true }, "owner");
	assert.equal(lines.length, 0);
	await (adapter as any).handleInteraction(button("owner"));
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(JSON.parse(lines[0]).confirmed, true);
	assert.match(requests.at(-1)!.body.content, /已选择：Yes/);
	assert.deepEqual(requests.at(-1)!.body.components, []);
	await (adapter as any).handleInteraction(button("owner"));
	assert.match(requests.at(-1)!.body.data.content, /已结束或超时/);
	assert.equal(lines.length, 1);
	resetInteractiveStateForTests();
}

// Free-text questions open a private modal and never echo the submitted content.
{
	resetInteractiveStateForTests();
	const { adapter, requests } = fakeDiscord();
	const lines: string[] = [];
	setStdinWriter((line) => lines.push(line));
	setActiveChannel({ platform: "discord", channelId: "c", userId: "owner" });
	(adapter as any).callbacks = { onInteractiveResponse: handleInteractiveResponse };
	await handleExtensionUiRequest({ type: "extension_ui_request", id: "input", method: "input", title: "Reason" }, adapter);
	await (adapter as any).handleInteraction({ type: 3, id: "open", token: "token", channel_id: "c", user: { id: "owner" }, message: { id: "sent-1" }, data: { custom_id: "ui:i:input" } });
	assert.equal(requests.at(-1)!.body.type, 9);
	await (adapter as any).handleInteraction({ type: 5, id: "submit", token: "token", channel_id: "c", user: { id: "owner" }, data: { custom_id: "ui:input:input", components: [{ components: [{ custom_id: "answer", value: "private answer" }] }] } });
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(JSON.parse(lines[0]).value, "private answer");
	const cleanup = requests.findLast((request) => request.method === "PATCH")!;
	assert.match(cleanup.body.content, /回答已提交/);
	assert.ok(!cleanup.body.content.includes("private answer"));
	const modal = buildDiscordInputModal({ requestId: "q", method: "editor", title: "t".repeat(70), prefill: "x".repeat(5000) }) as any;
	assert.equal(modal.title.length, 45);
	assert.equal(modal.components[0].components[0].value.length, 4000);
	resetInteractiveStateForTests();
}

// Timeout tells the user what happened and removes the abandoned controls.
{
	resetInteractiveStateForTests();
	const { adapter, requests } = fakeDiscord();
	setStdinWriter(() => {});
	setActiveChannel({ platform: "discord", channelId: "c", userId: "owner" });
	await handleExtensionUiRequest({ type: "extension_ui_request", id: "timeout", method: "select", title: "Choose", options: ["a"], timeout: 10 }, adapter);
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.match(requests.at(-1)!.body.content, /提问已超时/);
	assert.deepEqual(requests.at(-1)!.body.components, []);
	resetInteractiveStateForTests();
}

// A stop during an in-flight prompt send cancels Pi immediately and clears late controls.
{
	resetInteractiveStateForTests();
	const { adapter, requests } = fakeDiscord();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const original = (adapter as any).apiRequest;
	(adapter as any).apiRequest = async (...args: any[]) => { if (args[1]?.method === "POST") await gate; return original(...args); };
	const lines: string[] = [];
	setStdinWriter((line) => lines.push(line));
	setActiveChannel({ platform: "discord", channelId: "c", userId: "owner" });
	const sending = handleExtensionUiRequest({ type: "extension_ui_request", id: "inflight", method: "confirm", title: "Allow?" }, adapter);
	assert.equal(pendingUiCount(), 1);
	cancelUiRequest("inflight");
	assert.equal(JSON.parse(lines[0]).cancelled, true);
	release(); await sending;
	assert.equal(lines.length, 1);
	assert.equal(pendingUiCount(), 0);
	assert.match(requests.at(-1)!.body.content, /提问已取消/);
	resetInteractiveStateForTests();
}

// Native stop buttons are bound to the initiating user and expire on final delivery.
{
	const { adapter, requests } = fakeDiscord();
	const received: string[] = [];
	(adapter as any).callbacks = { onMessage: async (message: any) => received.push(message.content) };
	const replyId = await adapter.sendReply({ id: "input", channelId: "c", userId: "owner", platform: "discord", content: "hello", timestamp: 1 }, "thinking");
	assert.equal(requests[0].body.message_reference.message_id, "input");
	const click = (userId: string) => ({ type: 3, id: "click", token: "token", channel_id: "c", user: { id: userId }, message: { id: replyId }, data: { custom_id: "turn:stop" } });
	await (adapter as any).handleInteraction(click("other"));
	assert.equal(received.length, 0);
	await (adapter as any).handleInteraction(click("owner"));
	assert.deepEqual(received, ["/stop"]);
	await adapter.editMessage("c", replyId, "done", { finalize: true });
	assert.deepEqual(requests.at(-1)!.body.components, []);
	await (adapter as any).handleInteraction(click("owner"));
	assert.match(requests.at(-1)!.body.data.content, /已经结束/);
	assert.equal(received.length, 1);
}

// A model switch updates the selected picker rather than leaving "Switching…" forever.
{
	const { adapter, requests } = fakeDiscord();
	const pickerId = await adapter.sendModelPicker("c", "owner", [{ provider: "P", id: "model", name: "Model" }]);
	(adapter as any).callbacks = { onMessage: async () => { await adapter.sendMessage("c", "✅ Model changed"); } };
	await (adapter as any).handleInteraction({ type: 3, id: "selection", application_id: "app", token: "token", channel_id: "c", user: { id: "owner" }, message: { id: pickerId }, data: { custom_id: "modelsel", values: ["model:P/model"] } });
	assert.equal(requests.at(-1)!.endpoint, "/webhooks/app/token/messages/@original");
	assert.equal(requests.at(-1)!.body.content, "✅ Model changed");
}

// Resume pickers reject other users without clearing the original list.
{
	const { adapter, requests } = fakeDiscord();
	let received = 0;
	(adapter as any).callbacks = { onMessage: async () => { received++; await adapter.sendMessage("c", "Opened session"); } };
	const id = await adapter.sendButtons("c", "Sessions", [[{ text: "One", data: "resume:0" }]], "owner");
	await (adapter as any).handleInteraction({ type: 3, id: "selection", token: "token", channel_id: "c", user: { id: "other" }, message: { id }, data: { custom_id: "resume:0" } });
	assert.equal(received, 0);
	assert.equal(requests.at(-1)!.body.data.flags, 64);
	assert.equal(requests.at(-1)!.body.data.components, undefined);
}

// Guild mentions are stripped, and a reply to the bot also satisfies requireMention.
{
	const { adapter } = fakeDiscord();
	adapter.config.requireMention = true;
	(adapter as any).botUserId = "123";
	const received: string[] = [];
	(adapter as any).callbacks = { onMessage: async (message: any) => received.push(message.content) };
	const event = { id: "m", guild_id: "guild", channel_id: "c", author: { id: "user" }, timestamp: new Date().toISOString() };
	await (adapter as any).handleMessage({ ...event, content: "<@!123> hello" });
	await (adapter as any).handleMessage({ ...event, content: "yes", referenced_message: { author: { id: "123" } } });
	await (adapter as any).handleMessage({ ...event, content: "unrelated conversation" });
	assert.deepEqual(received, ["hello", "yes"]);
}

const codeParts = splitDiscordContent(`Code:\n\`\`\`typescript\n${"const value = 1;\n".repeat(400)}\`\`\`\nDone`);
assert.ok(codeParts.length > 2);
assert.ok(codeParts.every((part) => part.length <= 2000));
assert.ok(codeParts.every((part) => (part.match(/```/g) ?? []).length % 2 === 0));
assert.match(codeParts[1], /^```typescript\n/);
const emojiParts = splitDiscordContent("😀".repeat(2300));
assert.ok(emojiParts.every((part) => part.length <= 2000 && part.isWellFormed()));
assert.equal(emojiParts.join(""), "😀".repeat(2300));
assert.ok(truncateDiscordMarkdown(`\`\`\`js\n${"x".repeat(4000)}`, 1500).endsWith("```"));
console.log("discord experience tests passed");
