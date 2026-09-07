import assert from "node:assert/strict";
import { DiscordAdapter } from "../src/adapters/discord.js";

class FakeWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSED = 3;

	readyState = FakeWebSocket.OPEN;
	onopen: ((event: unknown) => void) | null = null;
	onmessage: ((event: { data: string }) => Promise<void>) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onclose: ((event: { code: number; reason: string }) => void) | null = null;
	readonly sent: string[] = [];

	constructor(_url: string) {}

	send(data: string): void {
		this.sent.push(data);
	}

	close(_code?: number, _reason?: string): void {
		this.readyState = FakeWebSocket.CLOSED;
	}
}

const originalWebSocket = globalThis.WebSocket;
const originalFetch = globalThis.fetch;
const originalRandom = Math.random;

try {
	(globalThis as any).WebSocket = FakeWebSocket;
	globalThis.fetch = async () =>
		new Response(JSON.stringify({ url: "wss://gateway.example" }), {
			status: 200,
		});
	Math.random = () => 1;

	let disconnects = 0;
	const adapter = new DiscordAdapter({
		platform: "discord",
		botToken: "token",
		enabled: true,
	});
	await adapter.start({
		onDisconnect: () => {
			disconnects++;
		},
	} as any);
	const socket = (adapter as any).wsConnection as FakeWebSocket;
	await socket.onmessage?.({
		data: JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }),
	});
	assert.equal(JSON.parse(socket.sent.at(-1) ?? "{}").op, 2);
	assert.equal((await adapter.getStatus()).connected, true);
	assert.ok((adapter as any).heartbeatTimeout);

	(adapter as any).sendHeartbeat(true);
	assert.equal((adapter as any).heartbeatTimeout, null);
	assert.ok((adapter as any).heartbeatInterval);

	socket.readyState = FakeWebSocket.CLOSED;
	socket.onclose?.({ code: 4004, reason: "bad token" });
	assert.equal(disconnects, 1);
	assert.equal((adapter as any).heartbeatTimeout, null);
	assert.equal((adapter as any).heartbeatInterval, null);
	assert.equal((adapter as any).wsConnection, null);
	assert.equal((adapter as any).running, false);
	assert.equal((await adapter.getStatus()).connected, false);

	await adapter.stop();
} finally {
	globalThis.WebSocket = originalWebSocket;
	globalThis.fetch = originalFetch;
	Math.random = originalRandom;
}

console.log("discord lifecycle tests passed");
