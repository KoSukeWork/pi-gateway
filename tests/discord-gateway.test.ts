import assert from "node:assert/strict";
import {
	buildDiscordHeartbeat,
	buildDiscordIdentify,
	buildDiscordResume,
	canResumeDiscordSession,
	discordReconnectDelayMs,
	isDiscordFatalClose,
} from "../src/adapters/discord-gateway.js";

assert.equal(isDiscordFatalClose(4004), true);
assert.equal(isDiscordFatalClose(4014), true);
assert.equal(isDiscordFatalClose(1006), false);
assert.equal(isDiscordFatalClose(null), false);

assert.equal(
	canResumeDiscordSession({ sessionId: "abc", sequence: 12 }),
	true,
);
assert.equal(
	canResumeDiscordSession({ sessionId: "abc", sequence: 0 }),
	true,
);
assert.equal(
	canResumeDiscordSession({ sessionId: "abc", sequence: null }),
	false,
);
assert.equal(
	canResumeDiscordSession({ sessionId: null, sequence: 12 }),
	false,
);
assert.equal(
	canResumeDiscordSession({
		sessionId: "abc",
		sequence: 12,
		closeCode: 4009,
	}),
	false,
);
assert.equal(
	canResumeDiscordSession({
		sessionId: "abc",
		sequence: 12,
		closeCode: 4000,
	}),
	true,
);
assert.equal(
	canResumeDiscordSession({
		sessionId: "abc",
		sequence: 12,
		invalidSessionResumable: false,
	}),
	false,
);
assert.equal(
	canResumeDiscordSession({
		sessionId: "abc",
		sequence: 12,
		invalidSessionResumable: true,
	}),
	true,
);

assert.equal(discordReconnectDelayMs(0), 5000);
assert.equal(discordReconnectDelayMs(1), 10000);
assert.equal(discordReconnectDelayMs(2), 20000);
assert.equal(discordReconnectDelayMs(3), 30000);
assert.equal(discordReconnectDelayMs(8), 30000);

assert.deepEqual(buildDiscordHeartbeat(0), { op: 1, d: 0 });
assert.deepEqual(buildDiscordHeartbeat(null), { op: 1, d: null });

const identify = buildDiscordIdentify("token", 33280);
assert.equal(identify.op, 2);
assert.equal(identify.d.token, "token");
assert.equal(identify.d.intents, 33280);

const resume = buildDiscordResume("token", "sess", 7);
assert.deepEqual(resume, {
	op: 6,
	d: { token: "token", session_id: "sess", seq: 7 },
});

console.log("discord gateway tests passed");