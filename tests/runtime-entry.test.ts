import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	isLoopbackHost,
	resolveDaemonInvocation,
	resolveRpcExtensionPath,
} from "../src/runtime-entry.js";

assert.equal(isLoopbackHost("localhost"), true);
assert.equal(isLoopbackHost("127.0.0.1"), true);
assert.equal(isLoopbackHost("0.0.0.0"), false);
assert.equal(isLoopbackHost("example.com"), false);

const root = await mkdtemp(join(tmpdir(), "pi-gateway-runtime-"));
const srcExtDir = join(root, "src", "extensions");
await mkdir(srcExtDir, { recursive: true });
await writeFile(join(root, "package.json"), "{\"name\":\"fixture\"}\n");
await writeFile(join(srcExtDir, "pi-gateway-ask-user-rpc.ts"), "export default () => {};\n");
await writeFile(join(root, "src", "index.ts"), "export {}\n");

const fromSrc = pathToFileURL(join(root, "src", "index.ts")).href;
assert.equal(
	resolveRpcExtensionPath(fromSrc),
	join(root, "src", "extensions", "pi-gateway-ask-user-rpc.ts"),
);

try {
	resolveDaemonInvocation(fromSrc);
	assert.fail("daemon resolve should fail without dist or tsx");
} catch (error) {
	assert.match(String(error), /cannot start a detached daemon/);
}

await rm(root, { recursive: true, force: true });
console.log("runtime-entry tests passed");
