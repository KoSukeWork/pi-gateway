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
	security: { allowAll: false }, platforms: { discord: { enabled: true, botToken: "fixture", allowedRoles: ["fixture-role"] } } }));

let mode: "fast" | "held" | "error" | "handled" | "preflight" = "fast";
let abortRetryOnly = false;
let askOnSwitch = false;
let waitingCommand: any;
let lateFollowup = false;
let failNextIdleProbe = false;
const activeAckWatchdogs = new Set<ReturnType<typeof setTimeout>>();
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
mock.method(globalThis, "setTimeout", (fn: any, delay: number, ...args: any[]) => {
	const handle = nativeSetTimeout(fn, delay, ...args);
	if (delay === 30_000) activeAckWatchdogs.add(handle);
	return handle;
});
mock.method(globalThis, "clearTimeout", (handle: any) => { activeAckWatchdogs.delete(handle); nativeClearTimeout(handle); });
let proc: any;
const commands: any[] = [];
function emit(...events: any[]) { proc.stdout.emit("data", Buffer.from(events.map((event) => JSON.stringify(event)).join("\n") + "\n")); }
function end(text = "final answer", stopReason = "stop") {
	const message = { role: "assistant", content: [{ type: "text", text }], stopReason, ...(stopReason === "error" ? { errorMessage: "provider unavailable" } : {}) };
	emit({ type: "message_end", message }, { type: "agent_end", messages: [message] });
}
mock.method(childProcess, "spawn", (_command: string, args: string[], options: any) => {
	assert.equal(options.env.PI_GATEWAY_RPC_CHILD, "1");
	assert.ok(!args.includes("--no-extensions"));
	proc = new EventEmitter() as any;
	proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
	proc.stdin = { writable: true, write: (line: string) => {
		const command = JSON.parse(line); commands.push(command);
		if (command.type === "extension_ui_response") {
			if (waitingCommand) {
				const pending = waitingCommand; waitingCommand = undefined;
				if (pending.type === "prompt") emit({ type: "message_end", message: { role: "custom", display: true, content: "preflight handled output" } });
				emit({ type: "response", id: pending.id, success: true });
			}
			return;
		}
		if (command.type === "prompt" && command.streamingBehavior === "steer") {
			if (lateFollowup) {
				const original = { role: "assistant", content: "answer before late followup", stopReason: "stop" };
				emit({ type: "message_end", message: original }, { type: "agent_end", messages: [original], willRetry: false }, { type: "agent_settled" });
				emit({ type: "response", id: command.id, success: true }, { type: "agent_start" }, { type: "message_start", message: { role: "assistant", content: [] } });
				const next = { role: "assistant", content: "answer to late followup", stopReason: "stop" };
				emit({ type: "message_end", message: next }, { type: "agent_end", messages: [next], willRetry: false }, { type: "agent_settled" });
			} else emit({ type: "response", id: command.id, success: true });
			return;
		}
		if (command.type === "get_state" && failNextIdleProbe) {
			failNextIdleProbe = false;
			emit({ type: "response", id: command.id, success: false, error: "temporary idle query failure" });
			return;
		}
		if ((command.type === "switch_session" && askOnSwitch) || (command.type === "prompt" && mode === "preflight")) {
			askOnSwitch = false; waitingCommand = command;
			emit({ type: "extension_ui_request", id: "preflight-question", method: "confirm", title: "Preflight permission?", message: "Await human approval" });
			return;
		}
		emit({ type: "response", id: command.id, success: true, ...(command.type === "get_state" ? { data: { isStreaming: false, isCompacting: false } } : {}) });
		if (command.type === "prompt") {
			if (mode === "handled") {
				emit({ type: "message_end", message: { role: "custom", display: true, content: "extension handled output" } }, { type: "message_end", message: { role: "custom", display: false, content: "hidden context" } });
				return;
			}
			emit({ type: "agent_start" }, { type: "message_start", message: { role: "assistant", content: [] } },
				{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "streamed text" } });
			if (mode === "fast") end();
			if (mode === "error") end("", "error");
		} else if (command.type === "abort") {
			if (abortRetryOnly) emit({ type: "auto_retry_end", success: false, finalError: "Retry cancelled" }, { type: "agent_settled" });
			else end("partial answer", "aborted");
		}
	} };
	proc.kill = () => { proc.emit("exit", 0); proc.emit("close", 0); return true; };
	return proc;
});
syncBuiltinESMExports();

const { DiscordAdapter } = await import("../src/adapters/discord.js");
let callbacks!: AdapterCallbacks;
const sends: Array<{ channel: string; content: string }> = [];
const edits: string[] = [];
let blockReply: Promise<void> | undefined;
let blockFinal: Promise<void> | undefined;
let failNextNotice = false;
mock.method(DiscordAdapter.prototype, "initialize", async () => {});
mock.method(DiscordAdapter.prototype, "start", async function (this: InstanceType<typeof DiscordAdapter>, value: AdapterCallbacks) {
	assert.deepEqual(this.config.allowedRoles, ["fixture-role"], "real startup must forward configured role restrictions");
	callbacks = value;
});
mock.method(DiscordAdapter.prototype, "setTyping", async () => {});
mock.method(DiscordAdapter.prototype, "setMessageReaction", async () => {});
mock.method(DiscordAdapter.prototype, "sendMessage", async (channel: string, content: string) => {
	if (failNextNotice && content.startsWith("↪️")) { failNextNotice = false; throw new Error("notice unavailable"); }
	sends.push({ channel, content }); return `m-${sends.length}`;
});
mock.method(DiscordAdapter.prototype, "sendReply", async (message: PlatformMessage, content: string) => { sends.push({ channel: message.channelId, content }); await blockReply; return `m-${sends.length}`; });
mock.method(DiscordAdapter.prototype, "editMessage", async (_channel: string, _id: string, content: string) => { await blockFinal; edits.push(content); });
mock.method(DiscordAdapter.prototype, "sendInteractive", async (_channel: string, prompt: any) => {
	if (prompt.message) sends.push({ channel: _channel, content: prompt.message });
	return { messageId: "dialog" };
});

const { default: gateway } = await import("../src/index.js");
const auth = await import("../src/security/auth.js");
const { pendingUiCount, getActiveChannel } = await import("../src/interactive.js");
const registered = new Map<string, any>();
const events = new Map<string, any>();
const previousChildFlag = process.env.PI_GATEWAY_RPC_CHILD;
process.env.PI_GATEWAY_RPC_CHILD = "1";
gateway(new Proxy({}, { get: () => { throw new Error("RPC child must not initialize another gateway"); } }) as any);
if (previousChildFlag === undefined) delete process.env.PI_GATEWAY_RPC_CHILD;
else process.env.PI_GATEWAY_RPC_CHILD = previousChildFlag;
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

	// Session hooks can ask in Discord before switch_session ACK, with no premature 30s cancellation.
	askOnSwitch = true;
	const switchingWithQuestion = callbacks.onMessage(message("/new")); await pause();
	assert.equal(pendingUiCount(), 1);
	assert.ok(sends.at(-1)!.content.includes("Await human approval"));
	assert.equal(activeAckWatchdogs.size, 0, "human session preflight must use the dialog deadline");
	await callbacks.onMessage(message("yes")); await switchingWithQuestion;
	assert.equal(commands.findLast((command) => command.type === "extension_ui_response").confirmed, true);
	assert.equal(getActiveChannel(), null);

	// Input hooks may ask before agent_start and authoritative prompt ACK.
	mode = "preflight";
	const preflight = callbacks.onMessage(message("permission before model")); await pause();
	assert.equal(pendingUiCount(), 1);
	assert.equal(activeAckWatchdogs.size, 0, "prompt ACK must not time out before its human question");
	await callbacks.onMessage(message("yes")); await preflight;
	assert.equal(edits.at(-1), "preflight handled output");
	assert.equal(getActiveChannel(), null);
	mode = "preflight";
	const preflightWithFollowup = callbacks.onMessage(message("handled preflight with supplemental input")); await pause();
	const preflightPromptCount = commands.filter((command) => command.type === "prompt").length;
	await callbacks.onMessage(message("supplement while input hook is waiting"));
	assert.equal(commands.filter((command) => command.type === "prompt").length, preflightPromptCount);
	assert.match(sends.at(-1)!.content, /扩展输入.*补充已排队/);
	mode = "fast";
	await callbacks.onMessage(message("yes")); await preflightWithFollowup;
	assert.equal(commands.filter((command) => command.type === "prompt").length, preflightPromptCount + 1);
	assert.match(commands.findLast((command) => command.type === "prompt").message, /supplement while input hook is waiting/);

	mode = "held";
	const running = callbacks.onMessage(message("long task"));
	await pause();
	emit({ type: "extension_ui_request", id: "editor-hint", method: "set_editor_text", text: "suggested editor text" });
	await pause();
	assert.equal(sends.at(-1)!.content, "suggested editor text");
	emit({ type: "extension_ui_request", id: "editor", method: "editor", title: "Enter path" });
	await pause();
	await callbacks.onMessage(message("/tmp/file\n  keep  \n"));
	assert.deepEqual(commands.at(-1), { type: "extension_ui_response", id: "editor", value: "/tmp/file\n  keep  \n" });
	await callbacks.onMessage(message("adjust requirements"));
	assert.equal(commands.at(-1)?.streamingBehavior, "steer");
	failNextNotice = true; const noticesBefore = sends.length;
	await callbacks.onMessage(message("accepted despite notice failure"));
	assert.equal(commands.at(-1)?.streamingBehavior, "steer");
	assert.equal(sends.length, noticesBefore, "an accepted steer must not be reported as unsubmitted");
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

	mode = "held";
	const race = callbacks.onMessage(message("model ends as supplemental input arrives")); await pause();
	lateFollowup = true;
	await callbacks.onMessage(message("late supplemental input")); await race; lateFollowup = false;
	assert.equal(edits.at(-1), "answer before late followup\n\nanswer to late followup");
	assert.equal(getActiveChannel(), null);
	const retriedProbe = callbacks.onMessage(message("acknowledged followup with failed idle probe")); await pause();
	lateFollowup = true; failNextIdleProbe = true;
	const noticesBeforeProbe = sends.length;
	await callbacks.onMessage(message("accepted followup despite idle query failure"));
	assert.ok(sends.slice(noticesBeforeProbe).some((item) => item.content.includes("已收到补充要求")));
	assert.ok(!sends.slice(noticesBeforeProbe).some((item) => item.content.includes("补充要求未提交")));
	await retriedProbe; lateFollowup = false;
	assert.equal(edits.at(-1), "answer before late followup\n\nanswer to late followup");

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

	// Modern Pi agent_end is intermediate; retries/compaction settle only at agent_settled.
	mode = "held";
	let retryFinished = false;
	const retrying = callbacks.onMessage(message("retry task")).then(() => { retryFinished = true; });
	await pause();
	const failed = { role: "assistant", content: [{ type: "text", text: "failed attempt" }], stopReason: "error", errorMessage: "HTTP 503" };
	emit({ type: "message_end", message: failed }, { type: "agent_end", messages: [failed], willRetry: true }, { type: "auto_retry_start", attempt: 1 });
	await pause();
	assert.equal(retryFinished, false, "a scheduled retry must keep ownership and the live reply");
	const recovered = { role: "assistant", content: [{ type: "text", text: "recovered answer" }], stopReason: "stop" };
	emit({ type: "agent_start" }, { type: "message_start", message: { role: "assistant", content: [] } }, { type: "message_end", message: recovered }, { type: "agent_end", messages: [recovered], willRetry: false });
	await pause(); assert.equal(retryFinished, false, "post-turn compaction can still be running");
	emit({ type: "agent_settled" }); await retrying;
	assert.equal(edits.at(-1), "recovered answer");

	const compacting = callbacks.onMessage(message("compaction recovery")); await pause();
	emit({ type: "message_end", message: failed }, { type: "agent_end", messages: [failed], willRetry: false }, { type: "compaction_start", reason: "overflow" });
	await pause();
	emit({ type: "compaction_end", reason: "overflow", willRetry: true }, { type: "agent_start" }, { type: "message_start", message: { role: "assistant", content: [] } }, { type: "message_end", message: recovered }, { type: "agent_end", messages: [recovered], willRetry: false }, { type: "agent_settled" });
	await compacting; assert.equal(edits.at(-1), "recovered answer");

	const cancellingRetry = callbacks.onMessage(message("cancel retry")); await pause();
	emit({ type: "message_end", message: failed }, { type: "agent_end", messages: [failed], willRetry: true }, { type: "auto_retry_start", attempt: 1 });
	await pause(); abortRetryOnly = true;
	await callbacks.onMessage(message("/stop")); await cancellingRetry; abortRetryOnly = false;
	assert.match(edits.at(-1)!, /🛑 已停止/);
	assert.ok(!edits.at(-1)!.includes("❌"));

	mode = "handled";
	await callbacks.onMessage(message("handled by input extension"));
	assert.equal(edits.at(-1), "extension handled output");

	mode = "held";
	const extensionFailure = callbacks.onMessage(message("extension diagnostic")); await pause();
	emit({ type: "extension_error", event: "input", error: "visible extension failure" });
	end(); await extensionFailure;
	assert.match(edits.at(-1)!, /final answer[\s\S]*visible extension failure/);

	// Owner input during final delivery belongs to a new turn, not a discarded preparation queue.
	mode = "fast"; let releaseFinal!: () => void;
	blockFinal = new Promise<void>((resolve) => { releaseFinal = resolve; });
	const delivering = callbacks.onMessage(message("final delivery held")); await pause();
	const beforeFollowup = commands.filter((command) => command.type === "prompt").length;
	await callbacks.onMessage(message("followup after model ended"));
	await callbacks.onMessage(message("second followup detail"));
	assert.equal(commands.filter((command) => command.type === "prompt").length, beforeFollowup);
	releaseFinal(); blockFinal = undefined; await delivering;
	assert.equal(commands.filter((command) => command.type === "prompt").length, beforeFollowup + 1);
	assert.match(commands.findLast((command) => command.type === "prompt").message, /followup after model ended\n\nsecond followup detail/);

	blockFinal = new Promise<void>((resolve) => { releaseFinal = resolve; });
	const deliveringCancel = callbacks.onMessage(message("delivery cancellation")); await pause();
	await callbacks.onMessage(message("queued then cancelled"));
	const beforeCancel = commands.filter((command) => command.type === "prompt").length;
	await callbacks.onMessage(message("/stop")); releaseFinal(); blockFinal = undefined; await deliveringCancel;
	assert.equal(commands.filter((command) => command.type === "prompt").length, beforeCancel);
	assert.match(sends.at(-1)!.content, /已取消排队的补充/);

	// An old worker's late exit cannot disconnect a replacement worker.
	mode = "held";
	const restarting = callbacks.onMessage(message("task interrupted by restart"));
	await pause();
	const oldProc = proc;
	await callbacks.onMessage(message("/restart", "admin"));
	await restarting;
	assert.notEqual(proc, oldProc);
	oldProc.emit("exit", 0);
	oldProc.emit("close", 0);
	mode = "fast";
	await callbacks.onMessage(message("after restart"));
	assert.equal(edits.at(-1), "final answer");

	// Child exit precedes drained stdout; the final unterminated event must survive.
	mode = "held"; let tailFinished = false;
	const tail = callbacks.onMessage(message("tail output")).then(() => { tailFinished = true; }); await pause();
	proc.emit("exit", 0); await pause(); assert.equal(tailFinished, false);
	emit({ type: "message_end", message: recovered }, { type: "agent_end", messages: [recovered], willRetry: false });
	proc.stdout.emit("data", Buffer.from(JSON.stringify({ type: "agent_settled" })));
	proc.emit("close", 0); await tail;
	assert.equal(edits.at(-1), "recovered answer");
	await callbacks.onMessage(message("/restart", "admin"));

	// Process death settles the waiter and frees ownership for future attempts.
	mode = "held";
	const dying = callbacks.onMessage(message("process death"));
	await pause(); proc.emit("exit", 1); proc.emit("close", 1); await dying;
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
