import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GATEWAY_CONFIG_DIR } from "../paths.js";
import type { SessionConfig } from "./store.js";

export function gatewaySessionFile(sessionId: string): string {
	if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error("Invalid gateway session id");
	return join(GATEWAY_CONFIG_DIR, "rpc-sessions", `${sessionId}.jsonl`);
}

/** A database chat identity must select an actual Pi history, including after restart. */
export function ensureGatewaySessionFile(session: SessionConfig, cwd = process.cwd()): string {
	const file = gatewaySessionFile(session.id);
	if (!existsSync(file)) {
		mkdirSync(join(GATEWAY_CONFIG_DIR, "rpc-sessions"), { recursive: true });
		writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: session.id, timestamp: new Date(session.createdAt).toISOString(), cwd })}\n`, { flag: "wx" });
	}
	return file;
}
