import assert from "node:assert/strict";
import { DiscordAdapter } from "../src/adapters/discord.js";
import { discordRetryAfterMs, splitDiscordContent, truncateDiscordMarkdown } from "../src/adapters/discord-interactive.js";
import { cancelUiRequest, handleExtensionUiRequest, handleInteractiveResponse, parseInteractiveTextReply, pendingUiCount, resetInteractiveStateForTests, setActiveChannel, setFlushHandler, setStdinWriter, setStreamRedirectHandler, tryConsumeTextReply } from "../src/interactive.js";

type Request = { endpoint: string; options: RequestInit; payload: any; file?: string };
function fixture() {
	const adapter = new DiscordAdapter({ platform: "discord", enabled: true, botToken: "fixture" });
	const requests: Request[] = [];
	let respond = (_request: Request): Response => new Response(JSON.stringify({ id: `sent-${requests.length}` }));
	(adapter as any).apiRequest = async (endpoint: string, options: RequestInit) => {
		const multipart = options.body instanceof FormData;
		const request: Request = { endpoint, options, payload: JSON.parse(multipart ? String(options.body.get("payload_json")) : String(options.body ?? "{}")),
			file: multipart ? await (options.body.get("files[0]") as Blob).text() : undefined };
		requests.push(request);
		return respond(request);
	};
	return { adapter, requests, response: (fn: typeof respond) => { respond = fn; } };
}

// An attachment replacing a failed first slash reply must settle @original.
{
	const f = fixture();
	f.response((r) => r.options.method === "PATCH" && r.file === undefined
		? new Response("denied", { status: 403 }) : new Response(JSON.stringify({ id: "attachment" })));
	(f.adapter as any).callbacks = { onMessage: async () => f.adapter.sendMessage("c", "complete answer") };
	await (f.adapter as any).handleInteraction({ type: 2, id: "slash", token: "token", application_id: "app", channel_id: "c", user: { id: "owner" }, data: { name: "help" } });
	const attachment = f.requests.find((r) => r.file !== undefined)!;
	assert.equal(attachment.endpoint, "/webhooks/app/token/messages/@original");
	assert.equal(attachment.options.method, "PATCH");
	assert.equal(attachment.file, "complete answer");
	assert.ok(!f.requests.some((r) => r.payload.content === "✅ 指令已处理。"));
}

// Slash and components observe the same guild channel restrictions as text.
{
	const f = fixture(); f.adapter.config.allowedChannels = ["allowed"];
	let calls = 0;
	(f.adapter as any).callbacks = { onMessage: async () => { calls++; } };
	await (f.adapter as any).handleInteraction({ type: 2, id: "s", token: "t", guild_id: "g", channel_id: "blocked", user: { id: "owner" }, data: { name: "help" } });
	assert.equal(calls, 0);
	assert.equal(f.requests.at(-1)!.payload.data.flags, 64);
}

// Role restrictions apply to text, slash commands, buttons and modal submissions.
{
	const f = fixture(); f.adapter.config.allowedRoles = ["allowed-role"];
	let calls = 0;
	(f.adapter as any).callbacks = { onMessage: async () => { calls++; }, onInteractiveResponse: () => { calls++; } };
	const context = { id: "request", token: "token", guild_id: "g", channel_id: "c", member: { user: { id: "owner" }, roles: ["other-role"] } };
	await (f.adapter as any).handleMessage({ ...context, author: { id: "owner" }, content: "hello" });
	for (const type of [2, 3, 5]) await (f.adapter as any).handleInteraction({ ...context, type, data: { name: "help", custom_id: "ui:input:question" } });
	assert.equal(calls, 0);
	assert.equal(f.requests.length, 3);
	assert.ok(f.requests.every((r) => r.payload.type === 4 && r.payload.data.flags === 64));
	await (f.adapter as any).handleMessage({ ...context, member: { ...context.member, roles: ["allowed-role"] }, author: { id: "owner" }, content: "hello" });
	assert.equal(calls, 1);
}

// A callback producing no reply must not leave its picker in "Switching" forever.
{
	const f = fixture();
	const id = await f.adapter.sendModelPicker("c", "owner", [{ provider: "P", id: "model", name: "Model" }]);
	(f.adapter as any).callbacks = { onMessage: async () => {} };
	await (f.adapter as any).handleInteraction({ type: 3, id: "selection", application_id: "app", token: "token", channel_id: "c", user: { id: "owner" }, message: { id }, data: { custom_id: "modelsel", values: ["model:P/model"] } });
	assert.equal(f.requests.at(-1)!.endpoint, "/webhooks/app/token/messages/@original");
	assert.match(f.requests.at(-1)!.payload.content, /操作未完成/);
}

// Huge outputs become complete attachments rather than flooding the channel.
{
	const f = fixture(); const text = "full output\n".repeat(8000);
	await f.adapter.sendMessage("c", text);
	assert.equal(f.requests.length, 1);
	assert.equal(f.requests[0].file, text);
}

// Discord can reject a reply reference even when fail_if_not_exists is false.
{
	const f = fixture();
	f.response((r) => r.payload.message_reference ? new Response(JSON.stringify({ code: 10008, message: "Unknown Message" }), { status: 404 }) : new Response(JSON.stringify({ id: "reply" })));
	await f.adapter.sendReply({ platform: "discord", channelId: "c", userId: "owner", id: "deleted", content: "hello", timestamp: 1 }, "thinking");
	assert.equal(f.requests.length, 2);
	assert.equal(f.requests[1].payload.message_reference, undefined);
}

// Removing a completed widget must not discard its full display information.
{
	const f = fixture();
	const { ChatReply } = await import("../src/chat-reply.js");
	const reply = new ChatReply(f.adapter, { platform: "discord", channelId: "c", userId: "owner", id: "m", content: "hi", timestamp: 1 });
	await reply.start();
	reply.event({ type: "extension_ui_request", method: "setWidget", widgetKey: "result", widgetLines: ["full widget result"] });
	reply.event({ type: "extension_ui_request", method: "setWidget", widgetKey: "result" });
	await reply.finish("answer");
	assert.ok(f.requests.some((r) => r.payload.content?.includes("full widget result")));
}

// A housekeeping DELETE failure must not turn a delivered reply into a resend.
{
	const f = fixture();
	await f.adapter.editMessage("c", "m", "x".repeat(4500));
	f.response((r) => r.options.method === "DELETE" ? new Response("denied", { status: 403 }) : new Response(JSON.stringify({ id: "m" })));
	const result = await f.adapter.editMessage("c", "m", "short final");
	assert.equal(result?.partial, false);
	assert.equal(f.requests.filter((r) => r.options.method === "POST").length, 2);
}

// Long placeholders and instructions remain in the full prompt attachment.
{
	const f = fixture(); resetInteractiveStateForTests();
	setActiveChannel({ platform: "discord", channelId: "c", userId: "owner" }); setStdinWriter(() => {});
	await handleExtensionUiRequest({ type: "extension_ui_request", id: "long", method: "input", title: "Answer", placeholder: "instruction".repeat(300) }, f.adapter);
	assert.ok(f.requests.some((r) => r.file?.includes("instruction".repeat(300))));
	resetInteractiveStateForTests();
}

// Extended Markdown fences and long language strings fit every final chunk.
{
	const opener = "````" + "language".repeat(20);
	const text = opener + "\n" + "  body  \n".repeat(500) + "````";
	const parts = splitDiscordContent(text);
	assert.ok(parts.every((p) => p.length <= 2000));
	assert.ok(parts.slice(1).every((p) => p.startsWith(opener + "\n")));
	assert.ok(parts.every((p) => p.endsWith("````")));
	assert.ok(truncateDiscordMarkdown(text, 700).endsWith("````"));
}

assert.equal(discordRetryAfterMs(429, JSON.stringify({ retry_after: 31 })), 31050);

// A pending answer preserves input indentation and needs no repeat mention.
{
	const f = fixture(); resetInteractiveStateForTests(); f.adapter.config.requireMention = true;
	(f.adapter as any).botUserId = "bot";
	setActiveChannel({ platform: "discord", channelId: "c", userId: "owner" }); setStdinWriter(() => {});
	await handleExtensionUiRequest({ type: "extension_ui_request", id: "input", method: "editor", title: "Text" }, f.adapter);
	const received: string[] = [];
	(f.adapter as any).callbacks = { onMessage: async (message: any) => { received.push(message.content); } };
	const raw = "    indented\n  ending  \n";
	await (f.adapter as any).handleMessage({ id: "m", guild_id: "g", channel_id: "c", author: { id: "owner" }, content: raw });
	assert.deepEqual(received, [raw]);
	assert.deepEqual(parseInteractiveTextReply(raw, { method: "editor" }), { value: raw });
	resetInteractiveStateForTests();
}

// Stop while flushing long contextual output must prevent a later permission prompt.
{
	const f = fixture(); resetInteractiveStateForTests();
	setActiveChannel({ platform: "discord", channelId: "c", userId: "owner" }); setStdinWriter(() => {});
	let release!: () => void;
	setFlushHandler(() => new Promise<void>((resolve) => { release = resolve; }));
	const sending = handleExtensionUiRequest({ type: "extension_ui_request", id: "flushing", method: "confirm", title: "Allow?" }, f.adapter);
	cancelUiRequest("flushing"); release(); await sending;
	assert.equal(f.requests.length, 0);
	resetInteractiveStateForTests();
}

// Without Attach Files permission, a long final still finishes as complete text.
{
	const f = fixture(); const text = "x".repeat(16100);
	f.response((r) => r.file !== undefined ? new Response("Missing Permissions", { status: 403 }) : new Response(JSON.stringify({ id: `m-${f.requests.length}` })));
	await f.adapter.editMessage("c", "m", text);
	assert.equal(f.requests.filter((r) => r.file === undefined).map((r) => r.payload.content).join(""), text);
}

// Code chunk decoration does not remove original text, spaces, or empty lines.
{
	const opener = "~~~~python";
	const text = opener + "\n" + "  code  \n\n".repeat(650) + "~~~~";
	const parts = splitDiscordContent(text);
	const original = parts.map((part, index) => {
		const withoutPrefix = index ? part.slice(opener.length + 1) : part;
		return index < parts.length - 1 ? withoutPrefix.slice(0, -5) : withoutPrefix;
	}).join("");
	assert.equal(original, text);
}

// Permission prompts remain usable when the bot cannot upload full-context files.
{
	const f = fixture(); const detail = "long permission context ".repeat(100);
	f.response((r) => r.file !== undefined ? new Response("denied", { status: 403 }) : new Response(JSON.stringify({ id: `m-${f.requests.length}` })));
	await f.adapter.sendInteractive("c", { requestId: "permission", method: "confirm", title: "Permission", message: detail });
	assert.ok(f.requests.filter((r) => r.file === undefined && !r.payload.components).map((r) => r.payload.content).join("").includes(detail));
	assert.equal(f.requests.at(-1)!.payload.components[0].components.length, 2);
}

// Long session/choice lists preserve the entries beyond the button message preview.
{
	const f = fixture(); const text = "Complete session choice\n".repeat(160);
	const id = await f.adapter.sendButtons("c", text, [[{ text: "One", data: "resume:0" }]], "owner");
	assert.equal(f.requests[0].file, text);
	assert.equal(id, "sent-2");
	assert.equal(f.requests[1].payload.components[0].components[0].custom_id, "resume:0");
}

// Explicit replies answer their own permission question, even with another dialog open.
{
	const f = fixture(); resetInteractiveStateForTests();
	const responses: any[] = []; let resumes = 0;
	setActiveChannel({ platform: "discord", channelId: "c", userId: "owner" });
	setStdinWriter((line) => responses.push(JSON.parse(line))); setStreamRedirectHandler(() => { resumes++; });
	await handleExtensionUiRequest({ type: "extension_ui_request", id: "A", method: "select", title: "A?", options: ["Allow A", "No"] }, f.adapter);
	await handleExtensionUiRequest({ type: "extension_ui_request", id: "B", method: "select", title: "B?", options: ["Allow B", "No"] }, f.adapter);
	assert.equal(tryConsumeTextReply("discord", "c", "1", "owner", "sent-1"), true);
	assert.equal(responses[0].id, "A"); assert.equal(responses[0].value, "Allow A");
	assert.equal(pendingUiCount(), 1); assert.equal(resumes, 0);
	assert.equal(tryConsumeTextReply("discord", "c", "1", "owner", "stale-dialog"), false);
	assert.equal(handleInteractiveResponse({ requestId: "B", value: "0" }, "owner"), true);
	assert.equal(resumes, 1); resetInteractiveStateForTests();
}

// Once the complete attachment has delivered, a failed placeholder edit must not resend it.
{
	const f = fixture(); const { ChatReply } = await import("../src/chat-reply.js");
	const reply = new ChatReply(f.adapter, { platform: "discord", channelId: "c", userId: "owner", id: "m", content: "hi", timestamp: 1 });
	await reply.start();
	f.response((r) => r.options.method === "PATCH" ? new Response("denied", { status: 403 }) : new Response(JSON.stringify({ id: "attachment" })));
	await reply.finish("long complete answer ".repeat(1000));
	assert.equal(f.requests.filter((r) => r.file !== undefined).length, 1);
}

// A replacement reply expires the original Stop button even when cleanup fails.
{
	const f = fixture(); const { ChatReply } = await import("../src/chat-reply.js");
	const reply = new ChatReply(f.adapter, { platform: "discord", channelId: "c", userId: "owner", id: "input", content: "hi", timestamp: 1 });
	await reply.start();
	const originalId = `sent-${f.requests.findIndex((r) => r.payload.components?.[0]?.components?.[0]?.custom_id === "turn:stop") + 1}`;
	f.response((r) => ["PATCH", "DELETE"].includes(String(r.options.method))
		? new Response("denied", { status: 403 }) : new Response(JSON.stringify({ id: "replacement" })));
	await reply.finish("complete answer");
	let stopped = 0;
	(f.adapter as any).callbacks = { onMessage: async () => { stopped++; } };
	await (f.adapter as any).handleInteraction({ type: 3, id: "old-stop", token: "t", channel_id: "c", user: { id: "owner" }, message: { id: originalId }, data: { custom_id: "turn:stop" } });
	assert.equal(stopped, 0, "a leftover Stop button must not control a new turn");
	assert.equal(f.requests.at(-1)!.payload.data.flags, 64);
	assert.match(f.requests.at(-1)!.payload.data.content, /任务已经结束/);
}

console.log("Discord Hermes review regressions passed");
