import assert from "node:assert/strict";
import { TelegramAdapter } from "../src/adapters/telegram.js";

const adapter = new TelegramAdapter({
	token: "test-token",
	webhookUrl: "https://example.com/webhook/telegram",
	webhookSecret: "expected-secret",
});

let handled = 0;
(adapter as unknown as { handleUpdate: (update: unknown) => Promise<void> }).handleUpdate =
	async () => {
		handled += 1;
	};

await assert.rejects(
	() => adapter.handleWebhookUpdate({ update_id: 1 }),
	/Invalid Telegram webhook secret/,
);
await assert.rejects(
	() => adapter.handleWebhookUpdate({ update_id: 1 }, "wrong"),
	/Invalid Telegram webhook secret/,
);
await adapter.handleWebhookUpdate({ update_id: 1 }, "expected-secret");
assert.equal(handled, 1);
console.log("telegram webhook tests passed");
