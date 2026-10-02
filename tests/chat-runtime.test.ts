import assert from "node:assert/strict";
import { mock } from "node:test";
import { EventEmitter } from "node:events";
import os from "node:os";
import http from "node:http";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { AdapterCallbacks, PlatformMessage } from "../src/adapters/base.js";

// Exercise the real gateway callbacks and RPC parser without the user's files or network.
const tempRoot = mkdtempSync(join(os.tmpdir(), "gateway-chat-runtime-"));
const tempParent = resolve(os.tmpdir()) + sep;
mock.method(os, "homedir", () => tempRoot);
const server = new EventEmitter() as any;
server.listen = (_port: number, _host: string, callback: () => void) => callback();
server.close = (callback: () => void) => callback();
mock.method(http, "createServer", () => server);
syncBuiltinESMExports();
const configDir = join(tempRoot, ".pi", "gateway");
mkdirSync(configDir, { recursive: true });
writeFileSync(join(configDir, "config.json"), JSON.stringify({ host: "127.0.0.1", port: 3847, enableWebSocket: false,
	security: { allowAll: false }, platforms: { discord: { enabled: true, botToken: "fixture" } } }));

let mode: "fast" | "held" | "error" = "fast";
let proc: any;
const commands: any[] = [];
function emit(...events: any[]) { proc.stdout.emit("data", Buffer.from(events.map((event) => JSON.stringify(event)).join("\n") + "\n")); }
function end(text = "final answer", stopReason = "stop") {
	const message = { role: "assistant", content: [{ type: "text", text }], stopReason, ...(stopReason === "error" ? { errorMessage: "provider unavailable" } : {}) };
	emit({ type: "message_end", message }, { type: "agent_end", messages: [message] });
}
mock.method(childProcess, "spawn", () => {
	proc = new EventEmitter() as any;
	proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
	proc.stdin = { writable: true, write: (line: string) => {
		const command = JSON.parse(line); commands.push(command);
		if (command.type === "extension_ui_response") return;
		emit({ type: "response", id: command.id, success: true });
		if (command.type === "prompt") {
			emit({ type: "agent_start" }, { type: "message_start", message: { role: "assistant", content: [] } },
				{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "streamed text" } });
			if (mode === "fast") end();
			if (mode === "error") end("", "error");
		} else if (command.type === "abort") end("partial answer", "aborted");
	} };
	proc.kill = () => { proc.emit("exit", 0); return true; };
	return proc;
});
syncBuiltinESMExports();

const { DiscordAdapter } = await import("../src/adapters/discord.js");
let callbacks!: AdapterCallbacks;
const sends: Array<{ channel: string; content: string }> = [];
const edits: string[] = [];
let blockReply: Promise<void> | undefined;
mock.method(DiscordAdapter.prototype, "initialize", async () => {});
mock.method(DiscordAdapter.prototype, "start", async (value: AdapterCallbacks) => { callbacks = value; });
mock.method(DiscordAdapter.prototype, "setTyping", async () => {});
mock.method(DiscordAdapter.prototype, "setMessageReaction", async () => {});
mock.method(DiscordAdapter.prototype, "sendMessage", async (channel: string, content: string) => { sends.push({ channel, content }); return `m-${sends.length}`; });
mock.method(DiscordAdapter.prototype, "sendReply", async (message: PlatformMessage, content: string) => { sends.push({ channel: message.channelId, content }); await blockReply; return `m-${sends.length}`; });
mock.method(DiscordAdapter.prototype, "editMessage", async (_channel: string, _id: string, content: string) => { edits.push(content); });

const { default: gateway } = await import("../src/index.js");
const auth = await import("../src/security/auth.js");
const registered = new Map<string, any>();
const events = new Map<string, any>();
gateway({ registerCommand: (name: string, command: any) => registered.set(name, command), registerTool: () => {}, on: (name: string, fn: any) => events.set(name, fn) } as any);
auth.addToAllowlist("discord", "owner"); auth.addToAllowlist("discord", "other"); auth.addToAllowlist("discord", "admin");
auth.addAdmin("discord", "admin");
const ctx = { ui: { notify: () => {}, setStatus: () => {} } };
function message(content = "hello", userId = "owner", channelId = "c"): PlatformMessage {
	return { platform: "discord", channelId, userId, content, id: String(Date.now()), timestamp: Date.now() };
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 10));

try {
	await registered.get("gateway").handler("start", ctx);
	// Fast ACK + agent_end in the same stdout callback must not leave the placeholder hanging.
	await callbacks.onMessage(message());
	assert.equal(edits.at(-1), "final answer");
	assert.equal(commands.filter((command) => command.type === "prompt").length, 1);
	const firstFile = commands.find((command) => command.type === "switch_session").sessionPath;
	await callbacks.onMessage(message("other channel", "owner", "second"));
	const otherFile = commands.findLast((command) => command.type === "switch_session").sessionPath;
	assert.notEqual(otherFile, firstFile);
	await callbacks.onMessage(message("return to first"));
	assert.equal(commands.findLast((command) => command.type === "switch_session").sessionPath, firstFile);
	await callbacks.onMessage(message("/new"));
	assert.notEqual(commands.findLast((command) => command.type === "switch_session").sessionPath, firstFile);

	mode = "held";
	const running = callbacks.onMessage(message("long task"));
	await pause();
	await callbacks.onMessage(message("adjust requirements"));
	assert.equal(commands.at(-1)?.type, "steer");
	const count = commands.length;
	await callbacks.onMessage(message("another user's task", "other"));
	await callbacks.onMessage(message("same user in another channel", "owner", "different"));
	await callbacks.onMessage(message("/new", "admin"));
	assert.equal(commands.length, count, "busy messages must not steer or switch the worker's session");
	await callbacks.onMessage(message("/stop", "other"));
	assert.equal(commands.length, count);
	assert.match(sends.at(-1)!.content, /只有任务发起者/);
	await callbacks.onMessage(message("/stop"));
	await running;
	assert.match(edits.at(-1)!, /partial answer\n\n🛑 已停止/);
	assert.ok(commands.some((command) => command.type === "abort"));

	// Stop while the Discord placeholder is in flight prevents the prompt from ever starting.
	let release!: () => void;
	blockReply = new Promise<void>((resolve) => { release = resolve; });
	const before = commands.length;
	const preparing = callbacks.onMessage(message("preparing task"));
	await pause();
	await callbacks.onMessage(message("/stop"));
	release(); await preparing; blockReply = undefined;
	assert.equal(commands.length, before);
	assert.match(edits.at(-1)!, /已停止/);

	// Failure carried by an assistant terminal message is a real failure, not an empty success.
	mode = "error";
	await callbacks.onMessage(message("error task"));
	assert.match(edits.at(-1)!, /❌ provider unavailable/);
	mode = "fast";
	await callbacks.onMessage(message("next task"));
	assert.equal(edits.at(-1), "final answer");

	// An old worker's late exit cannot disconnect a replacement worker.
	mode = "held";
	const restarting = callbacks.onMessage(message("task interrupted by restart"));
	await pause();
	const oldProc = proc;
	await callbacks.onMessage(message("/restart", "admin"));
	await restarting;
	assert.notEqual(proc, oldProc);
	oldProc.emit("exit", 0);
	mode = "fast";
	await callbacks.onMessage(message("after restart"));
	assert.equal(edits.at(-1), "final answer");

	// Process death settles the waiter and frees ownership for future attempts.
	mode = "held";
	const dying = callbacks.onMessage(message("process death"));
	await pause(); proc.emit("exit", 1); await dying;
	assert.match(edits.at(-1)!, /pi process exited/);
	await callbacks.onMessage(message("after death"));
	assert.match(sends.at(-1)!.content, /Pi 当前未运行/);
	console.log("chat runtime tests passed");
} finally {
	await registered.get("gateway").handler("stop", ctx);
	await events.get("session_shutdown")();
	mock.restoreAll(); syncBuiltinESMExports();
	assert.ok(resolve(tempRoot).startsWith(tempParent));
	rmSync(tempRoot, { recursive: true, force: true });
}
