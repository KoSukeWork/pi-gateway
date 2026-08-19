import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
