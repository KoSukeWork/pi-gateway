import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GATEWAY_CONFIG_DIR } from "../paths.js";

export interface ActiveSessionPointer {
	sessionFile: string;
	sessionId?: string;
	cwd?: string;
	updatedAt: number;
}

export interface ChannelSessionBinding {
	sessionFile: string;
	boundAt: number;
}

const ACTIVE_SESSION_FILE = join(GATEWAY_CONFIG_DIR, "active-session.json");
const BINDINGS_FILE = join(GATEWAY_CONFIG_DIR, "session-bindings.json");

function ensureDir(): void {
	if (!existsSync(GATEWAY_CONFIG_DIR)) {
		mkdirSync(GATEWAY_CONFIG_DIR, { recursive: true });
	}
}

export function publishActiveSession(pointer: Omit<ActiveSessionPointer, "updatedAt">): void {
	if (!pointer.sessionFile) return;
	ensureDir();
	const payload: ActiveSessionPointer = {
		...pointer,
		updatedAt: Date.now(),
	};
	writeFileSync(ACTIVE_SESSION_FILE, `${JSON.stringify(payload, null, 2)}\n`);
}

export function readActiveSession(): ActiveSessionPointer | null {
	try {
		if (!existsSync(ACTIVE_SESSION_FILE)) return null;
		const parsed = JSON.parse(readFileSync(ACTIVE_SESSION_FILE, "utf-8")) as ActiveSessionPointer;
		if (!parsed || typeof parsed.sessionFile !== "string" || !parsed.sessionFile) return null;
		return parsed;
	} catch {
		return null;
	}
}

export function sessionFileAgeMs(sessionFile: string): number | null {
	try {
		return Date.now() - statSync(sessionFile).mtimeMs;
	} catch {
		return null;
	}
}

function loadBindings(): Record<string, ChannelSessionBinding> {
	try {
		if (!existsSync(BINDINGS_FILE)) return {};
		const parsed = JSON.parse(readFileSync(BINDINGS_FILE, "utf-8"));
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function saveBindings(bindings: Record<string, ChannelSessionBinding>): void {
	ensureDir();
	writeFileSync(BINDINGS_FILE, `${JSON.stringify(bindings, null, 2)}\n`);
}

export function channelKey(platform: string, channelId: string): string {
	return `${platform}:${channelId}`;
}

export function getChannelBinding(platform: string, channelId: string): ChannelSessionBinding | null {
	return loadBindings()[channelKey(platform, channelId)] ?? null;
}

export function setChannelBinding(platform: string, channelId: string, sessionFile: string): void {
	const bindings = loadBindings();
	bindings[channelKey(platform, channelId)] = {
		sessionFile,
		boundAt: Date.now(),
	};
	saveBindings(bindings);
}

export function clearChannelBinding(platform: string, channelId: string): void {
	const bindings = loadBindings();
	delete bindings[channelKey(platform, channelId)];
	saveBindings(bindings);
}
