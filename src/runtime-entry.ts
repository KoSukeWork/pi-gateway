import { existsSync } from "node:fs";
import { join } from "node:path";
import { getPackageRoot } from "./paths.js";

export function findTsxCli(packageRoot: string): string | null {
	const candidates = [
		join(packageRoot, "node_modules", "tsx", "dist", "cli.mjs"),
		join(packageRoot, "node_modules", "tsx", "dist", "cli.js"),
	];
	return candidates.find((path) => existsSync(path)) ?? null;
}

export function resolveDaemonInvocation(importMetaUrl: string): {
	command: string;
	args: string[];
} {
	const root = getPackageRoot(importMetaUrl);
	const compiled = join(root, "dist", "index.js");
	const source = join(root, "src", "index.ts");
	const tsx = findTsxCli(root);

	if (existsSync(compiled)) {
		return { command: process.execPath, args: [compiled, "--daemon"] };
	}
	if (existsSync(source) && tsx) {
		return { command: process.execPath, args: [tsx, source, "--daemon"] };
	}
	throw new Error(
		"pi-gateway: cannot start a detached daemon without dist/index.js or the tsx dependency. Run npm run build, or install dependencies from git.",
	);
}

export function resolveRpcExtensionPath(importMetaUrl: string): string {
	const root = getPackageRoot(importMetaUrl);
	const source = join(root, "src", "extensions", "pi-gateway-ask-user-rpc.ts");
	const compiled = join(
		root,
		"dist",
		"extensions",
		"pi-gateway-ask-user-rpc.js",
	);
	if (existsSync(source)) return source;
	if (existsSync(compiled)) return compiled;
	throw new Error("pi-gateway: RPC helper extension is missing from the package");
}

export function isLoopbackHost(host: string): boolean {
	const normalized = host.trim().toLowerCase();
	return (
		normalized === "localhost" ||
		normalized === "127.0.0.1" ||
		normalized === "::1" ||
		normalized === "[::1]"
	);
}
