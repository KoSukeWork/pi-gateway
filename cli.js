#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const compiledCli = join(root, "dist", "cli.js");
const sourceCli = join(root, "src", "cli.ts");
const tsx = [
	join(root, "node_modules", "tsx", "dist", "cli.mjs"),
	join(root, "node_modules", "tsx", "dist", "cli.js"),
].find((path) => existsSync(path));

const args = process.argv.slice(2);

if (existsSync(compiledCli)) {
	const result = spawnSync(process.execPath, [compiledCli, ...args], {
		stdio: "inherit",
	});
	process.exit(result.status ?? 1);
}

if (existsSync(sourceCli) && tsx) {
	const result = spawnSync(process.execPath, [tsx, sourceCli, ...args], {
		stdio: "inherit",
	});
	process.exit(result.status ?? 1);
}

console.error(
	"pi-gateway: missing dist/cli.js and cannot run TypeScript via tsx. Run npm install && npm run build.",
);
process.exit(1);
