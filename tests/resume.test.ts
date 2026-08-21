import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseChatSessionCommand } from "../src/sessions/chat-commands.ts";
import {
	buildResumeAttachedMessage,
	formatResumeList,
	listRecentSessions,
	parseResumeCallback,
	rememberResumeList,
	resumeButtons,
	takeResumeChoice,
} from "../src/sessions/resume.ts";

assert.deepEqual(parseChatSessionCommand("/resume"), { name: "resume" });
assert.deepEqual(parseChatSessionCommand("/resume 3"), { name: "resume", index: 3 });
assert.deepEqual(parseChatSessionCommand("/RESUME 1"), { name: "resume", index: 1 });
assert.equal(parseResumeCallback("Callback: resume:2"), 2);
assert.equal(parseResumeCallback("/resume 2"), null);

const root = await mkdtemp(join(tmpdir(), "pi-gateway-resume-"));
const agentDir = join(root, "agent");
const projectA = join(agentDir, "sessions", "--A--");
const projectB = join(agentDir, "sessions", "--B--");
const rpcDir = join(root, "rpc-sessions");
await mkdir(projectA, { recursive: true });
await mkdir(projectB, { recursive: true });
await mkdir(rpcDir, { recursive: true });

const older = join(projectA, "older.jsonl");
const newer = join(projectB, "newer.jsonl");
const rpc = join(rpcDir, "rpc.jsonl");
const header = (cwd: string, text: string) =>
	`${JSON.stringify({ type: "session", version: 3, id: cwd, cwd, timestamp: "2026-08-21T00:00:00.000Z" })}\n${JSON.stringify({
		type: "message",
		timestamp: "2026-08-21T00:01:00.000Z",
		message: { role: "user", content: [{ type: "text", text }] },
	})}\n`;

await writeFile(older, header("Q:\\work\\alpha", "old topic"));
await writeFile(newer, header("Q:\\work\\beta", "new topic"));
await writeFile(rpc, header("C:\\Users\\admin\\pi-gateway-workspace", "isolated hi"));
const now = Date.parse("2026-08-21T06:00:00.000Z");
await utimes(older, new Date(now - 3 * 86400_000), new Date(now - 3 * 86400_000));
await utimes(rpc, new Date(now - 3600_000), new Date(now - 3600_000));
await utimes(newer, new Date(now - 60_000), new Date(now - 60_000));

try {
	const listed = listRecentSessions({
		agentDir,
		rpcSessionDir: rpcDir,
		limit: 8,
		now,
	});
	assert.equal(listed.length, 3);
	assert.equal(listed[0].sessionFile, newer);
	assert.equal(listed[1].sessionFile, rpc);
	assert.equal(listed[2].sessionFile, older);

	const text = formatResumeList(listed, {
		now,
		activeFile: newer,
		boundFile: rpc,
	});
	assert.match(text, /Pick a session to resume/);
	assert.match(text, /1\. beta · 1 min ago \(last desktop\)/);
	assert.match(text, /You: new topic/);
	assert.match(text, /this chat/);
	assert.match(text, /pi-gateway-workspace/);

	const buttons = resumeButtons(listed);
	assert.equal(buttons[0][0].data, "resume:0");
	assert.match(buttons[0][0].text, /^1 /);

	rememberResumeList("discord", "c1", listed.map((s) => s.sessionFile), now);
	const picked = takeResumeChoice("discord", "c1", 1, now);
	assert.equal(picked.ok, true);
	if (picked.ok) assert.equal(picked.sessionFile, rpc);
	const expired = takeResumeChoice("discord", "c1", 0, now);
	assert.equal(expired.ok, false);

	rememberResumeList("discord", "c2", [newer], now);
	const bad = takeResumeChoice("discord", "c2", 5, now);
	assert.equal(bad.ok, false);

	const attached = buildResumeAttachedMessage(newer, false, now);
	assert.match(attached, /Resumed this session/);
	assert.match(attached, /Project: Q:\\work\\beta/);

	console.log("resume tests passed");
} finally {
	await rm(root, { recursive: true, force: true });
}
