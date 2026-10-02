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
	["PATCH", "POST", "POST", "POST"],
);

// A failed continuation preserves the entire response in a UTF-8 attachment.
{
	const adapter = new DiscordAdapter({ platform: "discord", botToken: "test", enabled: true });
	const original = "中文 😀\n".repeat(600);
	let attached = "";
	(adapter as any).apiRequest = async (_endpoint: string, options: RequestInit) => {
		if (options.body instanceof FormData) {
			attached = await (options.body.get("files[0]") as Blob).text();
			return response(JSON.stringify({ id: "attachment" }));
		}
		return options.method === "PATCH" ? response("{}") : response("denied", 403);
	};
	const delivery = await adapter.editMessage("channel", "message", original);
	assert.equal(delivery?.partial, false);
	assert.equal(attached, original);
}

console.log("discord delivery tests passed");
