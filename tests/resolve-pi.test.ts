import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRpcPiArgs, resolvePiInvocation } from "../src/resolve-pi.js";

assert.deepEqual(
	resolvePiInvocation(["--mode", "rpc"], { platform: "linux" }),
	{ command: "pi", args: ["--mode", "rpc"] },
);

const root = await mkdtemp(join(tmpdir(), "pi-gateway-resolve-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
try {
	process.env.PI_CODING_AGENT_DIR = root;
	const npmPath = join(root, "npm", "node_modules", "@example", "interactive");
	const gitPath = join(root, "git", "github.com", "example", "interactive");
	await mkdir(npmPath, { recursive: true });
	await mkdir(gitPath, { recursive: true });
	await writeFile(join(root, "settings.json"), JSON.stringify({ packages: [
		"npm:@example/interactive@1.2.3",
		"git:https://github.com/example/interactive.git@abcdef",
		"npm:@example/pi-gateway@1.0.0",
	] }));
	const cliPath = join(root, "cli.js");
	await writeFile(cliPath, "console.log('pi')\n");
	assert.deepEqual(
		resolvePiInvocation(["--mode", "rpc"], {
			platform: "win32",
			execPath: "C:\\\\node.exe",
			argv: ["C:\\\\node.exe", cliPath],
		}),
		{ command: "C:\\\\node.exe", args: [cliPath, "--mode", "rpc"] },
	);
	const rpcArgs = buildRpcPiArgs("C:\\rpc.ts");
	assert.equal(rpcArgs[0], "--mode");
	assert.ok(rpcArgs.includes("--no-extensions"));
	assert.ok(rpcArgs.includes("--session-dir"));
	assert.ok(rpcArgs.includes("C:\\rpc.ts"));
	assert.ok(rpcArgs.includes(npmPath), "versioned npm extensions must load");
	assert.ok(rpcArgs.includes(gitPath), "pinned Git extensions must load");
	console.log("resolve-pi tests passed");
} finally {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await rm(root, { recursive: true, force: true });
}
