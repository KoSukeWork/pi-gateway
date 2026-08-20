import assert from "node:assert/strict";
import type { BaseAdapter } from "../src/adapters/base.js";
import {
	cancelUiRequest,
	cleanupPendingUiRequests,
	handleExtensionUiRequest,
	handleInteractiveResponse,
	parseInteractiveTextReply,
	pendingUiCount,
	resetInteractiveStateForTests,
	setActiveChannel,
	setStdinWriter,
	tryConsumeTextReply,
	type InteractiveUiRequest,
} from "../src/interactive.js";

function fakeAdapter(
	overrides: Partial<BaseAdapter> = {},
): BaseAdapter {
	return {
		platform: "discord",
		config: { enabled: true, platform: "discord" },
		initialize: async () => {},
		start: async () => {},
		stop: async () => {},
		sendMessage: async () => "m1",
		editMessage: async () => {},
		deleteMessage: async () => {},
		setTyping: async () => {},
		getStatus: async () => ({ connected: true }),
		sendInteractive: async () => ({ messageId: "msg-1" }),
		cleanupInteractive: async () => {},
		...overrides,
	} as BaseAdapter;
}

function selectRequest(id = "req-1"): InteractiveUiRequest {
	return {
		type: "extension_ui_request",
		id,
		method: "select",
		title: "Permission Required",
		options: ["Yes", "Yes, for this session", "No", "No, provide reason"],
	};
}

{
	assert.deepEqual(
		parseInteractiveTextReply("1", {
			method: "select",
			options: ["Yes", "No"],
		}),
		{ value: "0" },
	);
	assert.deepEqual(
		parseInteractiveTextReply("Yes", {
			method: "select",
			options: ["Yes", "No"],
		}),
		{ value: "Yes" },
	);
	assert.deepEqual(
		parseInteractiveTextReply("y", {
			method: "select",
			options: ["Yes", "No"],
		}),
		{ value: "Yes" },
	);
	assert.equal(
		parseInteractiveTextReply("hello", {
			method: "select",
			options: ["Yes", "No"],
		}),
		null,
	);
	assert.deepEqual(
		parseInteractiveTextReply("yes", { method: "confirm" }),
		{ confirmed: true },
	);
	assert.deepEqual(
		parseInteractiveTextReply("because secrets", { method: "input" }),
		{ value: "because secrets" },
	);
}

{
	resetInteractiveStateForTests();
	const lines: string[] = [];
	setStdinWriter((line) => lines.push(line.trim()));
	cancelUiRequest("missing-id");
	assert.equal(lines.length, 1);
	assert.deepEqual(JSON.parse(lines[0]), {
		type: "extension_ui_response",
		id: "missing-id",
		cancelled: true,
	});
}

{
	resetInteractiveStateForTests();
	const lines: string[] = [];
	setStdinWriter((line) => lines.push(line.trim()));
	await handleExtensionUiRequest(selectRequest("orphan"), fakeAdapter());
	assert.equal(pendingUiCount(), 0);
	assert.deepEqual(JSON.parse(lines[0]), {
		type: "extension_ui_response",
		id: "orphan",
		cancelled: true,
	});
}

{
	resetInteractiveStateForTests();
	const lines: string[] = [];
	setStdinWriter((line) => lines.push(line.trim()));
	setActiveChannel({
		platform: "discord",
		channelId: "c1",
		userId: "u1",
	});
	await handleExtensionUiRequest(
		selectRequest("ok-1"),
		fakeAdapter({
			sendInteractive: async () => ({ messageId: "m-ok" }),
		}),
	);
	assert.equal(pendingUiCount(), 1);
	assert.equal(
		tryConsumeTextReply("discord", "c1", "1", "u1"),
		true,
	);
	assert.equal(pendingUiCount(), 0);
	assert.deepEqual(JSON.parse(lines[0]), {
		type: "extension_ui_response",
		id: "ok-1",
		value: "Yes",
	});
}

{
	resetInteractiveStateForTests();
	const lines: string[] = [];
	setStdinWriter((line) => lines.push(line.trim()));
	setActiveChannel({
		platform: "discord",
		channelId: "c1",
		userId: "u1",
	});
	await handleExtensionUiRequest(
		selectRequest("other-user"),
		fakeAdapter(),
	);
	assert.equal(tryConsumeTextReply("discord", "c1", "1", "u2"), false);
	assert.equal(pendingUiCount(), 1);
	handleInteractiveResponse({ requestId: "other-user", value: "0" }, "u2");
	assert.equal(pendingUiCount(), 1);
	assert.equal(lines.length, 0);
	handleInteractiveResponse({ requestId: "other-user", value: "0" }, "u1");
	assert.equal(pendingUiCount(), 0);
	assert.equal(JSON.parse(lines[0]).value, "Yes");
}

{
	resetInteractiveStateForTests();
	const lines: string[] = [];
	setStdinWriter((line) => lines.push(line.trim()));
	setActiveChannel({ platform: "discord", channelId: "c1", userId: "u1" });
	await handleExtensionUiRequest(
		{ ...selectRequest("timeout-2"), timeout: 20 },
		fakeAdapter(),
	);
	assert.equal(pendingUiCount(), 1);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(pendingUiCount(), 0);
	assert.deepEqual(JSON.parse(lines[0]), {
		type: "extension_ui_response",
		id: "timeout-2",
		cancelled: true,
	});
}

{
	resetInteractiveStateForTests();
	const lines: string[] = [];
	let cleaned = 0;
	setStdinWriter((line) => lines.push(line.trim()));
	setActiveChannel({ platform: "discord", channelId: "c1", userId: "u1" });
	await handleExtensionUiRequest(
		selectRequest("cleanup-1"),
		fakeAdapter({
			cleanupInteractive: async () => {
				cleaned += 1;
			},
		}),
	);
	cleanupPendingUiRequests();
	assert.equal(pendingUiCount(), 0);
	assert.equal(cleaned, 1);
	assert.deepEqual(JSON.parse(lines[0]), {
		type: "extension_ui_response",
		id: "cleanup-1",
		cancelled: true,
	});
}

{
	resetInteractiveStateForTests();
	const lines: string[] = [];
	setStdinWriter((line) => lines.push(line.trim()));
	setActiveChannel({ platform: "discord", channelId: "c1", userId: "u1" });
	await handleExtensionUiRequest(
		selectRequest("send-fail"),
		fakeAdapter({
			sendInteractive: async () => {
				throw new Error("Discord 2000 char limit");
			},
		}),
	);
	assert.equal(pendingUiCount(), 0);
	assert.deepEqual(JSON.parse(lines[0]), {
		type: "extension_ui_response",
		id: "send-fail",
		cancelled: true,
	});
}

resetInteractiveStateForTests();
console.log("interactive-bridge tests passed");
