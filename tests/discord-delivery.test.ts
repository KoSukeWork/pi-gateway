import assert from "node:assert/strict";
import { DiscordAdapter } from "../src/adapters/discord.js";

function response(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const retrying = new DiscordAdapter({
	platform: "discord",
	botToken: "test",
	enabled: true,
});
let retryCalls = 0;
(retrying as any).apiRequest = async () => {
	retryCalls++;
	return retryCalls === 1
		? response(JSON.stringify({ retry_after: 0 }), 429)
		: response("{}", 200);
};
await retrying.editMessage("channel", "message", "updated");
assert.equal(retryCalls, 2);

const patchFailure = new DiscordAdapter({
	platform: "discord",
	botToken: "test",
	enabled: true,
});
(patchFailure as any).apiRequest = async () => response("denied", 403);
await assert.rejects(
	patchFailure.editMessage("channel", "message", "updated"),
	/Failed to edit message/,
);

const partial = new DiscordAdapter({
	platform: "discord",
	botToken: "test",
	enabled: true,
});
const requests: Array<{ endpoint: string; method: string }> = [];
let postCount = 0;
(partial as any).apiRequest = async (
	endpoint: string,
	options: RequestInit,
) => {
	requests.push({ endpoint, method: String(options.method) });
	if (options.method === "PATCH") return response("{}", 200);
	postCount++;
	if (postCount === 1) return response(JSON.stringify({ id: "extra-1" }), 200);
	return response("network unavailable", 503);
};

// PATCH and the first overflow chunk succeed; the final overflow fails.
// editMessage must not throw, because the generic caller would then resend
// the complete response and duplicate the chunks already visible.
await partial.editMessage("channel", "message", "x".repeat(4500));
assert.deepEqual(
	requests.map((request) => request.method),
	["PATCH", "POST", "POST"],
);

console.log("discord delivery tests passed");
