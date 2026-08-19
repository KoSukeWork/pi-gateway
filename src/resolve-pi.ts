import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { GATEWAY_CONFIG_DIR } from "./paths.js";

export interface PiInvocation {
	command: string;
	args: string[];
}

function isCliJsPath(value: string | undefined): value is string {
	if (!value) return false;
	return value.replace(/\\/g, "/").toLowerCase().endsWith("/cli.js");
}

function resolvedInstalledPiCliPath(): string | undefined {
	try {
		const packageEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
		const entryPath = fileURLToPath(packageEntry);
		const cliPath = join(dirname(entryPath), "cli.js");
		if (existsSync(cliPath)) return cliPath;
	} catch {
		// not resolvable from this package
	}
	return undefined;
}

function resolvedWindowsPiInvocation(
	args: string[],
	execPath: string,
): PiInvocation | undefined {
	const pathEntries = (process.env.PATH ?? process.env.Path ?? "")
		.split(";")
		.map((entry) => entry.trim().replace(/^"|"$/g, ""))
		.filter(Boolean);

	for (const directory of pathEntries) {
		for (const executableName of ["pi.exe", "pi.com"]) {
			const executablePath = join(directory, executableName);
			if (existsSync(executablePath)) {
				return { command: executablePath, args };
			}
		}

		if (!existsSync(join(directory, "pi.cmd")) && !existsSync(join(directory, "pi.bat"))) {
			continue;
		}

		for (const cliPath of [
			join(directory, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
			join(directory, "node_modules", "@earendil-works", "pi-coding-agent", "cli.js"),
		]) {
			if (existsSync(cliPath)) {
				return { command: execPath, args: [cliPath, ...args] };
			}
		}
	}

	return undefined;
}

function agentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR?.trim();
	if (configured) return configured;
	return join(homedir(), ".pi", "agent");
}

function installedPackagePath(source: string): string | null {
	const git = source.match(/^git:(?:https?:\/\/)?(.+?)(?:\.git)?$/i);
	if (git) {
		const repo = git[1].replace(/^github\.com\//i, "github.com/");
		const path = join(agentDir(), "git", ...repo.split("/").filter(Boolean));
		return existsSync(path) ? path : null;
	}
	const npm = source.match(/^npm:(.+)$/i);
	if (npm) {
		const path = join(agentDir(), "npm", "node_modules", npm[1]);
		return existsSync(path) ? path : null;
	}
	return null;
}

function settingsPackageSources(): string[] {
	try {
		const settings = JSON.parse(readFileSync(join(agentDir(), "settings.json"), "utf-8"));
		const packages = settings?.packages;
		if (!Array.isArray(packages)) return [];
		return packages
			.map((entry) => (typeof entry === "string" ? entry : entry?.source))
			.filter((source): source is string => typeof source === "string");
	} catch {
		return [];
	}
}

/** Args for the gateway RPC child: isolated session dir, no nested gateway. */
export function buildRpcPiArgs(rpcExtensionPath: string): string[] {
	const args = [
		"--mode",
		"rpc",
		"--no-extensions",
		"--session-dir",
		join(GATEWAY_CONFIG_DIR, "rpc-sessions"),
		"--extension",
		rpcExtensionPath,
	];
	for (const source of settingsPackageSources()) {
		if (/pi-gateway/i.test(source)) continue;
		const path = installedPackagePath(source);
		if (path) args.push("--extension", path);
	}
	return args;
}

export function resolvePiInvocation(
	args: string[],
	options: { platform?: NodeJS.Platform; execPath?: string; argv?: string[] } = {},
): PiInvocation {
	const platform = options.platform ?? process.platform;
	if (platform !== "win32") {
		return { command: "pi", args };
	}

	const argv = options.argv ?? process.argv;
	const currentCli = argv[1];
	if (isCliJsPath(currentCli) && existsSync(currentCli)) {
		return {
			command: options.execPath ?? process.execPath,
			args: [currentCli, ...args],
		};
	}

	const installed = resolvedInstalledPiCliPath();
	if (installed) {
		return {
			command: options.execPath ?? process.execPath,
			args: [installed, ...args],
		};
	}

	const fallback = resolvedWindowsPiInvocation(args, options.execPath ?? process.execPath);
	if (fallback) return fallback;

	throw new Error(
		"Unable to resolve the Pi CLI on Windows. Add the directory that contains pi.cmd to PATH, or start the gateway from a Pi session.",
	);
}
