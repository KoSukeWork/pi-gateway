import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRpcPiArgs, resolvePiInvocation } from "../src/resolve-pi.js";

assert.deepEqual(
	resolvePiInvocation(["--mode", "rpc"], { platform: "linux" }),
	{ command: "pi", args: ["--mode", "rpc"] },
);

const root = await mkdtemp(join(tmpdir(), "pi-gateway-resolve-"));
try {
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
	console.log("resolve-pi tests passed");
} finally {
	await rm(root, { recursive: true, force: true });
}
