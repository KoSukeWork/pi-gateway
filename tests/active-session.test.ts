import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testHome = await mkdtemp(join(tmpdir(), "pi-gateway-active-"));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

const {
	publishActiveSession,
	readActiveSession,
	setChannelBinding,
	getChannelBinding,
	clearChannelBinding,
	sessionFileAgeMs,
} = await import(`../src/sessions/active-session.ts?home=${Date.now()}`);

try {
	assert.equal(readActiveSession(), null);
	const sessionFile = join(testHome, "demo.jsonl");
	await writeFile(sessionFile, "{}\n");
	publishActiveSession({ sessionFile, sessionId: "abc", cwd: testHome });
	const active = readActiveSession();
	assert.equal(active?.sessionFile, sessionFile);
	assert.equal(active?.sessionId, "abc");
	assert.ok((sessionFileAgeMs(sessionFile) ?? 999999) < 5000);

	setChannelBinding("telegram", "1", sessionFile);
	assert.equal(getChannelBinding("telegram", "1")?.sessionFile, sessionFile);
	clearChannelBinding("telegram", "1");
	assert.equal(getChannelBinding("telegram", "1"), null);
	console.log("active-session tests passed");
} finally {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = originalUserProfile;
	await rm(testHome, { recursive: true, force: true });
}
