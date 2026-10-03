import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { buildRpcPiArgs } from "../src/resolve-pi.js";

// Real CLI startup, offline, with no user settings/auth or model requests.
const root = await mkdtemp(join(tmpdir(), "gateway-rpc-extensions-"));
const agentDir = join(root, "agent");
const cwd = join(root, "workspace");
const repo = fileURLToPath(new URL("../", import.meta.url));
const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
const npmPath = join(agentDir, "npm", "node_modules", "@fixture", "interaction");
const gitPath = join(agentDir, "git", "github.com", "fixture", "interaction");
const disabledPath = join(root, "disabled");
const commandSource = (name: string) => `export default function(pi) { pi.registerCommand(${JSON.stringify(name)}, { description: "fixture", handler: async () => {} }); }`;
async function put(path: string, text: string) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); }

async function commands(): Promise<string[]> {
	const args = buildRpcPiArgs(join(repo, "src", "extensions", "pi-gateway-ask-user-rpc.ts"));
	args[args.indexOf("--session-dir") + 1] = join(root, "sessions");
	args.push("--no-session", "--no-skills", "--no-prompt-templates");
	const child = spawn(process.execPath, [cli, ...args], { cwd, env: {
		PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
		TEMP: tmpdir(), TMP: tmpdir(), PI_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "1", PI_GATEWAY_RPC_CHILD: "1",
	}, stdio: ["pipe", "pipe", "pipe"] });
	let output = ""; let errors = "";
	let commandNames: string[] = [];
	let handledText = ""; let extensionDiagnostic = "";
	child.stderr.setEncoding("utf8"); child.stderr.on("data", (data) => { errors += data; });
	const closed = new Promise<void>((done) => child.once("close", () => done()));
	try {
		return await new Promise<string[]>((done, fail) => {
			const timer = setTimeout(() => fail(new Error(`RPC startup timed out: ${errors}`)), 20_000);
			child.once("error", (error) => { clearTimeout(timer); fail(error); });
			child.once("close", () => { clearTimeout(timer); fail(new Error(`RPC exited before commands: ${errors}`)); });
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (data) => {
				output += data;
				let newline: number;
				while ((newline = output.indexOf("\n")) >= 0) {
					const line = output.slice(0, newline); output = output.slice(newline + 1);
					let event: any; try { event = JSON.parse(line); } catch { continue; }
					if (event.type === "extension_error") extensionDiagnostic = event.error;
					if (event.type === "message_end" && event.message?.role === "custom" && event.message.display) handledText = event.message.content;
					if (event.id === "commands") {
						if (!event.success) { clearTimeout(timer); fail(new Error(JSON.stringify(event))); continue; }
						commandNames = event.data.commands.map((command: any) => command.name);
						// This is the late-arrival case: the worker is already idle.
						child.stdin.write(JSON.stringify({ id: "followup", type: "prompt", message: "fixture-handled-followup", streamingBehavior: "steer" }) + "\n");
					} else if (event.id === "followup") {
						if (!event.success) { clearTimeout(timer); fail(new Error(JSON.stringify(event))); continue; }
						child.stdin.write(JSON.stringify({ id: "idle", type: "get_state" }) + "\n");
					} else if (event.id === "idle") {
						clearTimeout(timer);
						if (!event.success || event.data.pendingMessageCount !== 0 || handledText !== "complete handled followup" || extensionDiagnostic !== "fixture extension diagnostic") fail(new Error(`Late followup was stranded or diagnostic was lost: ${JSON.stringify(event)}`));
						else done(commandNames);
					}
				}
			});
			child.stdin.write(JSON.stringify({ id: "commands", type: "get_commands" }) + "\n");
		});
	} finally { child.kill(); await closed; }
}

try {
	await mkdir(cwd, { recursive: true });
	await mkdir(gitPath, { recursive: true });
	await put(join(npmPath, "package.json"), JSON.stringify({ name: "@fixture/interaction", version: "1.2.3", pi: { extensions: ["./enabled.ts", "./excluded.ts"] } }));
	await put(join(npmPath, "enabled.ts"), commandSource("fixture-package"));
	await put(join(npmPath, "excluded.ts"), commandSource("fixture-excluded"));
	await put(join(disabledPath, "package.json"), JSON.stringify({ pi: { extensions: ["./index.ts"] } }));
	await put(join(disabledPath, "index.ts"), commandSource("fixture-disabled"));
	await put(join(agentDir, "extensions", "fixture.ts"), `export default function(pi) {
		pi.registerCommand("fixture-global", { description: "fixture", handler: async () => {} });
		pi.on("input", (event) => { if (event.text === "fixture-handled-followup") throw new Error("fixture extension diagnostic"); });
		pi.on("input", (event) => {
			if (event.text !== "fixture-handled-followup") return { action: "continue" };
			pi.sendMessage({ customType: "fixture", content: "complete handled followup", display: true }, { triggerTurn: false });
			return { action: "handled" };
		});
	}`);
	await put(join(cwd, ".pi", "extensions", "fixture.ts"), commandSource("fixture-project"));
	const settings = { defaultProjectTrust: "always", packages: [
		{ source: "npm:@fixture/interaction@1.2.3", extensions: ["enabled.ts"] },
		{ source: disabledPath, extensions: [] }, repo,
	] };
	await put(join(agentDir, "settings.json"), JSON.stringify(settings));
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }) });
	assert.equal(packageManager.getInstalledPath("git:https://github.com/fixture/interaction.git@abcdef", "user"), gitPath);
	assert.equal(packageManager.getInstalledPath("npm:@fixture/interaction@1.2.3", "user"), npmPath);
	const trusted = await commands();
	for (const name of ["fixture-package", "fixture-global", "fixture-project"]) assert.ok(trusted.includes(name), `missing ${name}`);
	for (const name of ["gateway", "fixture-excluded", "fixture-disabled"]) assert.ok(!trusted.includes(name), `unexpected ${name}`);
	await put(join(agentDir, "settings.json"), JSON.stringify({ ...settings, defaultProjectTrust: "never" }));
	const untrusted = await commands();
	assert.ok(!untrusted.includes("fixture-project"), "untrusted project extensions must stay disabled");
	assert.ok(untrusted.includes("fixture-global"));
	console.log("RPC extension loading tests passed (real isolated Pi CLI)");
} finally {
	assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
	await rm(root, { recursive: true, force: true });
}
