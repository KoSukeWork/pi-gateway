import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePiInvocation } from "../src/resolve-pi.js";

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
	console.log("resolve-pi tests passed");
} finally {
	await rm(root, { recursive: true, force: true });
}
