import assert from "node:assert/strict";
import { test } from "node:test";
import { installDeferred } from "../src/lazy-extension.ts";

const register = test;

type InstallArgs = Parameters<typeof installDeferred>;
type DeferredPi = InstallArgs[0];
type DeferredLoad = InstallArgs[1];
type Factory = (pi: unknown) => unknown;
type LoadAttempt = () => Promise<unknown>;

function createHarness(): {
	pi: DeferredPi;
	blockingEvent: (event: string) => Promise<unknown>;
} {
	const handlers = new Map<string, (event?: unknown, ctx?: unknown) => unknown>();
	const pi = {
		on(event: string, handler: (event?: unknown, ctx?: unknown) => unknown) {
			handlers.set(event, handler);
		},
		registerCommand() {},
	};
	return {
		pi: pi as unknown as DeferredPi,
		blockingEvent: async (event) => {
			const handler = handlers.get(event);
			if (!handler) throw new Error(`no handler registered for ${event}`);
			await handler();
		},
	};
}

async function captureRejection(pending: Promise<unknown>): Promise<Error> {
	try {
		await pending;
	} catch (error) {
		return error as Error;
	}
	throw new Error("expected the deferred attempt to reject");
}

register("installs the real factory once and reuses it across events", async () => {
	const { pi, blockingEvent } = createHarness();
	let loadCalls = 0;
	let factoryCalls = 0;
	const load = async (): Promise<{ default: Factory }> => {
		loadCalls += 1;
		return {
			default: (runtime: unknown) => {
				factoryCalls += 1;
				return runtime;
			},
		};
	};
	installDeferred(pi, load as unknown as DeferredLoad);
	await blockingEvent("tool_call");
	await blockingEvent("agent_start");
	assert.strictEqual(loadCalls, 1);
	assert.strictEqual(factoryCalls, 1);
});

register("surfaces the first load error when a retried load resolves a partial namespace", async () => {
	const { pi, blockingEvent } = createHarness();
	const attempts: LoadAttempt[] = [
		() => Promise.reject(new Error("Cannot find module 'zod'")),
		() => Promise.resolve({ default: { notAFactory: true } }),
	];
	const load = async (): Promise<unknown> => {
		const next = attempts.shift();
		if (!next) throw new Error("no queued load attempt");
		return next();
	};
	installDeferred(pi, load as unknown as DeferredLoad);
	const error = await captureRejection(blockingEvent("tool_call"));
	assert.match(error.message, /does not export a factory/);
	assert.match(error.message, /Cannot find module 'zod'/);
});

register("retries transient load failures and throws the last error", async () => {
	const { pi, blockingEvent } = createHarness();
	let loadCalls = 0;
	const load = async (): Promise<unknown> => {
		loadCalls += 1;
		throw new Error("EACCES: transient fs failure");
	};
	installDeferred(pi, load as unknown as DeferredLoad);
	const error = await captureRejection(blockingEvent("tool_call"));
	assert.match(error.message, /EACCES: transient fs failure/);
	assert.strictEqual(loadCalls, 3);
});

register("does not re-run the factory after it started executing", async () => {
	const { pi, blockingEvent } = createHarness();
	let loadCalls = 0;
	let factoryCalls = 0;
	const load = async (): Promise<{ default: Factory }> => {
		loadCalls += 1;
		return {
			default: () => {
				factoryCalls += 1;
				throw new Error("factory exploded");
			},
		};
	};
	installDeferred(pi, load as unknown as DeferredLoad);
	const first = await captureRejection(blockingEvent("tool_call"));
	assert.match(first.message, /factory exploded/);
	const second = await captureRejection(blockingEvent("agent_start"));
	assert.match(second.message, /factory exploded/);
	assert.strictEqual(loadCalls, 1);
	assert.strictEqual(factoryCalls, 1);
});

register("shares one deferred attempt across concurrent blocking events", async () => {
	const { pi, blockingEvent } = createHarness();
	let loadCalls = 0;
	let factoryCalls = 0;
	const load = (): Promise<{ default: Factory }> =>
		new Promise((resolve) => {
			loadCalls += 1;
			setTimeout(() => {
				resolve({
					default: () => {
						factoryCalls += 1;
						return "installed";
					},
				});
			}, 20);
		});
	installDeferred(pi, load as unknown as DeferredLoad);
	await Promise.all([blockingEvent("tool_call"), blockingEvent("agent_start")]);
	assert.strictEqual(loadCalls, 1);
	assert.strictEqual(factoryCalls, 1);
});
