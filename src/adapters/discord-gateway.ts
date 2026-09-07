/**
 * Pure Discord Gateway helpers.
 * Kept out of the adapter so resume/close-code policy can be unit-tested
 * without a WebSocket or bot token.
 */

/** Close codes that must not reconnect (token/intents/shard are wrong). */
export const DISCORD_FATAL_CLOSE_CODES = new Set([
	4004, // Authentication failed
	4010, // Invalid shard
	4011, // Sharding required
	4012, // Invalid API version
	4013, // Invalid intent(s)
	4014, // Disallowed intent(s)
]);

/** Close codes that can reconnect but must IDENTIFY, not RESUME. */
export const DISCORD_NON_RESUMABLE_CLOSE_CODES = new Set([
	4007, // Invalid seq
	4009, // Session timed out
]);

export function isDiscordFatalClose(code?: number | null): boolean {
	return code != null && DISCORD_FATAL_CLOSE_CODES.has(code);
}

export function canResumeDiscordSession(options: {
	sessionId: string | null;
	sequence: number | null;
	closeCode?: number | null;
	invalidSessionResumable?: boolean | null;
}): boolean {
	if (!options.sessionId || options.sequence == null) return false;
	if (options.invalidSessionResumable === false) return false;
	if (isDiscordFatalClose(options.closeCode)) return false;
	if (
		options.closeCode != null &&
		DISCORD_NON_RESUMABLE_CLOSE_CODES.has(options.closeCode)
	) {
		return false;
	}
	return true;
}

export function discordReconnectDelayMs(
	attempt: number,
	base = 5000,
	max = 30_000,
): number {
	const n = Math.max(0, Math.floor(attempt));
	return Math.min(max, base * 2 ** n);
}

export function buildDiscordHeartbeat(sequence: number | null): {
	op: 1;
	d: number | null;
} {
	return { op: 1, d: sequence };
}

export function buildDiscordIdentify(
	token: string,
	intents: number,
): {
	op: 2;
	d: {
		token: string;
		intents: number;
		properties: { os: string; browser: string; device: string };
	};
} {
	return {
		op: 2,
		d: {
			token,
			intents,
			properties: {
				os: "linux",
				browser: "pi-gateway",
				device: "pi-gateway",
			},
		},
	};
}

export function buildDiscordResume(
	token: string,
	sessionId: string,
	sequence: number | null,
): { op: 6; d: { token: string; session_id: string; seq: number | null } } {
	return {
		op: 6,
		d: {
			token,
			session_id: sessionId,
			seq: sequence,
		},
	};
}