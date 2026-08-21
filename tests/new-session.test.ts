import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseChatSessionCommand } from "../src/sessions/chat-commands.ts";
import {
	buildNewSessionMessage,
	createProjectSessionFile,
	encodeSessionCwd,
	resolveSessionCwd,
	sessionDirForCwd,
} from "../src/sessions/new-session.ts";

assert.deepEqual(parseChatSessionCommand("/new"), { name: "new" });
assert.deepEqual(parseChatSessionCommand("/NEW"), { name: "new" });
assert.deepEqual(parseChatSessionCommand("/new Q:\\Temp\\Work\\App"), {
	name: "new",
	path: "Q:\\Temp\\Work\\App",
});
assert.deepEqual(parseChatSessionCommand('/new "Q:\\Temp\\My Project"'), {
	name: "new",
	path: "Q:\\Temp\\My Project",
});
assert.deepEqual(parseChatSessionCommand("/continue"), { name: "continue" });
assert.equal(parseChatSessionCommand("/continue extra"), null);
assert.equal(parseChatSessionCommand("hello"), null);

const root = await mkdtemp(join(tmpdir(), "pi-gateway-new-"));
const project = join(root, "project");
const agentDir = join(root, "agent");
await mkdir(project);

try {
	const missing = resolveSessionCwd(join(root, "nope"), root);
	assert.equal(missing.ok, false);

	const fileTarget = join(root, "file.txt");
	await writeFile(fileTarget, "x\n");
	const notDir = resolveSessionCwd(fileTarget, root);
	assert.equal(notDir.ok, false);

	const ok = resolveSessionCwd("project", root);
	assert.equal(ok.ok, true);
	if (ok.ok) assert.equal(ok.cwd, project);

	const tilde = resolveSessionCwd("~");
	assert.equal(tilde.ok, true);

	const now = new Date("2026-08-21T05:00:00.000Z");
	const id = "11111111-2222-4333-8444-555555555555";
	const sessionFile = createProjectSessionFile(project, { agentDir, now, id });
	assert.equal(
		sessionFile,
		join(sessionDirForCwd(project, agentDir), `2026-08-21T05-00-00-000Z_${id}.jsonl`),
	);
	assert.match(encodeSessionCwd(project), /project/);
	const raw = await readFile(sessionFile, "utf8");
	const header = JSON.parse(raw);
	assert.equal(header.type, "session");
	assert.equal(header.version, 3);
	assert.equal(header.id, id);
	assert.equal(header.cwd, project);

	const message = buildNewSessionMessage({
		sessionFile,
		cwd: project,
		now: Date.parse("2026-08-21T05:00:10.000Z"),
	});
	assert.match(message, /Started a new conversation/);
	assert.match(message, new RegExp(`Project: ${project.replace(/\\/g, "\\\\")}`));

	console.log("new-session tests passed");
} finally {
	await rm(root, { recursive: true, force: true });
}
