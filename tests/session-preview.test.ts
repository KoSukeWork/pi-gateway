import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildContinueMessage,
	buildSessionStatusMessage,
	formatAge,
	formatSessionPreview,
	readSessionPreview,
	truncateChatMessage,
} from "../src/sessions/session-preview.ts";

const dir = await mkdtemp(join(tmpdir(), "pi-gateway-preview-"));
const sessionFile = join(dir, "demo.jsonl");
const now = Date.parse("2026-08-21T04:00:00.000Z");

const jsonl = [
	JSON.stringify({
		type: "session",
		version: 3,
		id: "01a02209-9d3b-7766-9b33-ad10360fd80a",
		timestamp: "2026-08-21T01:57:30.555Z",
		cwd: "Q:\\Temp\\Work\\Pi_Certification",
	}),
	JSON.stringify({
		type: "model_change",
		id: "m1",
		parentId: null,
		timestamp: "2026-08-21T01:57:30.781Z",
		provider: "Work",
		modelId: "grok-4.6",
	}),
	JSON.stringify({
		type: "message",
		id: "u1",
		timestamp: "2026-08-21T01:58:00.000Z",
		message: {
			role: "user",
			content: [{ type: "text", text: "Fix the lazy loader" }],
		},
	}),
	JSON.stringify({
		type: "message",
		id: "a1",
		timestamp: "2026-08-21T01:58:10.000Z",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "hidden" },
				{ type: "text", text: "I will inspect the bootstrap." },
				{ type: "toolCall", name: "read" },
			],
			provider: "Work",
			model: "grok-4.6",
		},
	}),
	JSON.stringify({
		type: "message",
		id: "u2",
		timestamp: "2026-08-21T03:52:56.277Z",
		message: {
			role: "user",
			content: [
				{
					type: "text",
					text: "我们来解决一个gateway的实际痛点。我在discord上进行继续一个会话，但是因为没有上下文信息，所以我无法判断是否是正确的会话",
				},
			],
		},
	}),
	JSON.stringify({
		type: "message",
		id: "a2",
		timestamp: "2026-08-21T03:53:02.494Z",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "planning" },
				{
					type: "text",
					text: "先摸清现状：gateway 在 Discord 上续会话时缺了哪些上下文。",
				},
			],
			provider: "Work",
			model: "grok-4.6",
		},
	}),
	JSON.stringify({
		type: "message",
		id: "a3",
		timestamp: "2026-08-21T03:54:00.000Z",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", name: "bash" }],
		},
	}),
	"{not json",
].join("\n");

try {
	await writeFile(sessionFile, `${jsonl}\n`);

	const preview = readSessionPreview(sessionFile);
	assert.equal(preview.exists, true);
	assert.equal(preview.cwd, "Q:\\Temp\\Work\\Pi_Certification");
	assert.equal(preview.sessionId, "01a02209-9d3b-7766-9b33-ad10360fd80a");
	assert.equal(preview.model, "Work/grok-4.6");
	assert.equal(preview.firstUserText, "Fix the lazy loader");
	assert.match(preview.lastUserText ?? "", /没有上下文信息/);
	assert.match(preview.lastAssistantText ?? "", /先摸清现状/);
	assert.equal(preview.updatedAt, "2026-08-21T03:54:00.000Z");

	const card = formatSessionPreview(preview, now);
	assert.match(card, /Project: Q:\\Temp\\Work\\Pi_Certification/);
	assert.match(card, /Updated: 6 min ago/);
	assert.match(card, /Model: Work\/grok-4\.6/);
	assert.match(card, /Topic: Fix the lazy loader/);
	assert.match(card, /You: 我们来解决一个gateway的实际痛点/);
	assert.match(card, /Pi: 先摸清现状/);
	assert.doesNotMatch(card, /hidden|planning|toolCall/);
	assert.ok(!card.includes("thinking"));

	const missing = readSessionPreview(join(dir, "nope.jsonl"));
	assert.equal(missing.exists, false);
	assert.match(formatSessionPreview(missing), /Session file not found/);

	const emptyFile = join(dir, "empty.jsonl");
	await writeFile(emptyFile, "");
	const empty = readSessionPreview(emptyFile);
	assert.equal(empty.exists, true);
	assert.equal(empty.firstUserText, undefined);

	const htmlFile = join(dir, "html.jsonl");
	await writeFile(
		htmlFile,
		`${JSON.stringify({
			type: "session",
			id: "html",
			cwd: "C:\\work",
		})}\n${JSON.stringify({
			type: "message",
			timestamp: "2026-08-21T03:59:00.000Z",
			message: {
				role: "user",
				content: [{ type: "text", text: "compare a < b & c > d" }],
			},
		})}\n`,
	);
	const htmlCard = formatSessionPreview(readSessionPreview(htmlFile), now);
	assert.match(htmlCard, /You: compare a ‹ b ＆ c › d/);

	assert.equal(formatAge(now - 10_000, now), "just now");
	assert.equal(formatAge(now - 3 * 60_000, now), "3 min ago");
	assert.equal(formatAge(now - 5 * 3600_000, now), "5 h ago");
	assert.equal(formatAge(now - 3 * 86400_000, now), "3 d ago");

	const continueText = buildContinueMessage({
		active: {
			sessionFile,
			sessionId: "fallback-id",
			cwd: "fallback-cwd",
		},
		hot: true,
		now,
	});
	assert.match(continueText, /Attached to the last desktop Pi session/);
	assert.match(continueText, /Project: Q:\\Temp\\Work\\Pi_Certification/);
	assert.match(continueText, /Warning: that session file was written in the last 15s/);
	assert.doesNotMatch(continueText, /fallback-cwd/);

	const isolated = buildSessionStatusMessage({
		boundFile: null,
		active: { sessionFile, sessionId: "01a02209-9d3b-7766-9b33-ad10360fd80a" },
		now,
	});
	assert.match(isolated, /isolated gateway session/);
	assert.match(isolated, /Last desktop Pi session/);
	assert.match(isolated, /Project: Q:\\Temp\\Work\\Pi_Certification/);

	const attachedSame = buildSessionStatusMessage({
		boundFile: sessionFile,
		active: { sessionFile },
		now,
	});
	assert.match(attachedSame, /attached to the last desktop Pi session/);
	assert.equal(attachedSame.includes("Last desktop Pi session:"), false);

	const attachedOther = buildSessionStatusMessage({
		boundFile: sessionFile,
		active: { sessionFile: join(dir, "other.jsonl"), cwd: "C:\\other" },
		now,
	});
	assert.match(attachedOther, /This chat is attached to:/);
	assert.match(attachedOther, /Last desktop Pi session:/);
	assert.match(attachedOther, /Session file not found/);

	const none = buildSessionStatusMessage({ boundFile: null, active: null, now });
	assert.match(none, /isolated gateway session/);
	assert.match(none, /No desktop Pi session has been published yet/);

	const truncated = truncateChatMessage("abcdefghij", 8);
	assert.equal(truncated.endsWith("…(truncated)") || truncated.length <= 8, true);
	assert.ok(truncateChatMessage("short").length === 5);

	console.log("session-preview tests passed");
} finally {
	await rm(dir, { recursive: true, force: true });
}
