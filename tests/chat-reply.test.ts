import assert from "node:assert/strict";
import { ChatReply } from "../src/chat-reply.js";
import { AssistantStream, agentEndText, agentEndError } from "../src/agent-response.js";
import { ownsChatTurn } from "../src/chat-turn.js";
import type { PlatformAdapter, PlatformMessage } from "../src/adapters/base.js";

{
	const stream = new AssistantStream();
	stream.consume({ type: "message_end", message: { role: "custom", display: true, content: "extension notice" } });
	assert.equal(stream.consume({ type: "message_end", message: { role: "custom", display: false, content: "private context" } }), null);
	const assistant = { role: "assistant", content: [{ type: "text", text: "answer" }] };
	stream.consume({ type: "message_end", message: assistant });
	assert.equal(stream.finalText({ messages: [assistant] }), "answer\n\nextension notice");
	assert.equal(stream.finalText({ messages: [assistant, { role: "custom", display: true, content: "extension notice" }] }), "answer\n\nextension notice");
}

assert.match(agentEndText({ messages: [{ role: "assistant", content: "partial", stopReason: "length" }] }), /输出长度限制/);

const message: PlatformMessage = { id: "input", platform: "discord", channelId: "channel", userId: "owner", content: "hello", timestamp: 1 };
const pause = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));
function fakeAdapter() {
	const edits: Array<{ content: string; finalize: boolean }> = [];
	const sends: string[] = [];
	const reactions: Array<[string, boolean]> = [];
	const deletes: string[] = [];
	const adapter: PlatformAdapter = {
		platform: "discord", config: { enabled: true, platform: "discord" },
		initialize: async () => {}, start: async () => {}, stop: async () => {},
		sendMessage: async (_channel, text) => { sends.push(text); return "reply"; },
		editMessage: async (_channel, _id, content, options) => { edits.push({ content, finalize: options?.finalize !== false }); },
		deleteMessage: async (_channel, id) => { deletes.push(id); },
		setMessageReaction: async (_channel, _id, emoji, enabled) => { reactions.push([emoji, enabled]); },
		setTyping: async () => {}, getStatus: async () => ({ connected: true }),
		sendInteractive: async () => ({ messageId: "prompt" }),
	};
	return { adapter, edits, sends, reactions, deletes };
}

// An empty terminal event retains the stream and complete extension display.
{
	const f = fakeAdapter();
	const reply = new ChatReply(f.adapter, message, 1);
	await reply.start();
	reply.stream("complete streamed answer");
	reply.event({ type: "extension_ui_request", method: "setWidget", widgetKey: "details", widgetLines: ["x".repeat(500)] });
	await reply.finish("");
	assert.match(f.edits.at(-1)!.content, /complete streamed answer/);
	assert.ok(f.edits.at(-1)!.content.includes("x".repeat(500)));
}

// Permission context is fully delivered once, before the dialog is displayed.
{
	const f = fakeAdapter(); const reply = new ChatReply(f.adapter, message, 1);
	await reply.start(); const context = "complete context ".repeat(250);
	reply.stream(context);
	await reply.waitForAnswer(); await reply.waitForAnswer();
	assert.equal(f.sends.filter((text) => text.includes(context)).length, 1);
	await reply.finish("answer");
}

// A blocked streaming PATCH must finish before the final edit. Later deltas are coalesced.
{
	const f = fakeAdapter();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const edit = f.adapter.editMessage;
	f.adapter.editMessage = async (...args) => {
		if (args[3]?.finalize === false) await gate;
		return edit(...args);
	};
	const reply = new ChatReply(f.adapter, message, 1);
	await reply.start();
	reply.stream("old preview");
	await pause();
	reply.stream("new preview");
	const finished = reply.finish("final answer");
	await pause();
	assert.equal(f.edits.length, 0);
	release();
	await finished;
	await pause();
	assert.equal(f.edits.at(-1)?.content, "final answer");
	assert.equal(f.edits.filter((edit) => edit.finalize).length, 1);
	assert.equal(f.sends.length, 1);
	assert.deepEqual(f.reactions, [["👀", true], ["👀", false], ["✅", true]]);
	reply.stream("late delta");
	await reply.finish("duplicate final");
	assert.equal(f.edits.at(-1)?.content, "final answer");
}

// Tools, permission questions, and responses retain one reply, with explicit phases.
{
	const f = fakeAdapter();
	const reply = new ChatReply(f.adapter, message, 1);
	await reply.start();
	reply.event({ type: "tool_execution_start", toolCallId: "t", toolName: "read" });
	await pause();
	assert.match(f.edits.at(-1)!.content, /正在执行 read/);
	reply.waitForAnswer();
	await pause();
	assert.match(f.edits.at(-1)!.content, /等待你的回答/);
	reply.resume();
	reply.stream("text after answering");
	await reply.finish("text before question\n\ntext after answering");
	assert.equal(f.sends.length, 1);
	assert.match(f.edits.at(-1)!.content, /text before question/);
}

for (const outcome of ["error", "stopped"] as const) {
	const f = fakeAdapter();
	const reply = new ChatReply(f.adapter, message, 1);
	await reply.start();
	reply.stream("partial work");
	await reply.finish(outcome === "error" ? "provider failed" : "", outcome);
	assert.match(f.edits.at(-1)!.content, /partial work/);
	assert.match(f.edits.at(-1)!.content, outcome === "error" ? /❌ provider failed/ : /🛑 已停止/);
	assert.deepEqual(f.reactions.at(-1), [outcome === "error" ? "❌" : "🛑", true]);
}

// A missing/deleted edit target falls back once, then removes the stale placeholder.
{
	const f = fakeAdapter();
	f.adapter.editMessage = async () => { throw new Error("Unknown Message"); };
	const reply = new ChatReply(f.adapter, message);
	await reply.start();
	await reply.finish("recovered answer");
	assert.equal(f.sends.at(-1), "recovered answer");
	assert.deepEqual(f.deletes, ["reply"]);
}

// Partial final delivery is visible and gets a failure reaction, not a success ack.
{
	const f = fakeAdapter();
	f.adapter.editMessage = async () => ({ partial: true, deliveredChunks: 2, totalChunks: 3 });
	const reply = new ChatReply(f.adapter, message);
	await reply.start();
	await reply.finish("a long answer");
	assert.match(f.sends.at(-1)!, /2\/3/);
	assert.deepEqual(f.reactions.at(-1), ["❌", true]);
}

const stream = new AssistantStream();
// Shutdown can begin while the initial REST send is blocked; it joins one final delivery.
{
	const f = fakeAdapter();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const send = f.adapter.sendMessage;
	f.adapter.sendMessage = async (...args) => { await gate; return send(...args); };
	const reply = new ChatReply(f.adapter, message, 1);
	const started = reply.start();
	await pause();
	const finished = reply.finish("gateway shutdown", "stopped");
	assert.equal(reply.finish("duplicate"), finished);
	release(); await started; await finished;
	assert.equal(f.sends.length, 1);
	assert.match(f.edits.at(-1)!.content, /gateway shutdown\n\n🛑 已停止/);
}

assert.equal(stream.consume({ type: "message_start", message: { role: "assistant", content: [] } }), "");
assert.equal(stream.consume({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private reasoning" } }), null);
assert.equal(stream.consume({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "before" } }), "before");
assert.equal(stream.consume({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "before" }] } }), "before");
stream.consume({ type: "message_start", message: { role: "toolResult", content: [{ type: "text", text: "tool output" }] } });
stream.consume({ type: "message_start", message: { role: "assistant", content: [] } });
assert.equal(stream.consume({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "after" } }), "before\n\nafter");
assert.equal(agentEndText({ messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "public" }] }] }), "public");
assert.equal(agentEndError({ messages: [{ role: "assistant", stopReason: "error", errorMessage: "HTTP 503" }] }), "HTTP 503");
assert.equal(ownsChatTurn(message, { ...message, userId: "other" }), false);
assert.equal(ownsChatTurn(message, { ...message, channelId: "other" }), false);
assert.equal(ownsChatTurn(message, { ...message, platform: "telegram" }), false);
assert.equal(ownsChatTurn(message, { ...message, id: "follow-up" }), true);
console.log("chat reply tests passed");
