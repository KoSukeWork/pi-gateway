import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { BLOCKING_EVENTS, REPLAY_EVENTS, installDeferred } from "../src/lazy-extension.ts";

const register = test;

type InstallArgs = Parameters<typeof installDeferred>;
type DeferredPi = InstallArgs[0];
type DeferredLoad = InstallArgs[1];
type Handler = (event: unknown, ctx: unknown) => unknown;

// Faithful mini-model of Pi 0.84.3 event dispatch: handlers live in arrays and
// the dispatcher iterates the live array, so handlers registered during a
// dispatch are reached by that same dispatch (this is how the deferred loader
// delivers events to the real factory).
function createFakePi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, unknown>();
	const tools: Array<{ name: string }> = [];
	let activeTools: unknown;
	// Anything-proxy: unknown ExtensionAPI members resolve to a callable that
	// tolerates arbitrary member access and calls, so real factories that touch
	// host-provided helpers (eventemitter-like objects, ui helpers, ...) do not
	// crash the harness on shapes the loader contract does not care about.
	// eslint-disable-next-line
	const anything: unknown = new Proxy(function anything() {}, {
		get(_target, prop) {
			if (prop === "then") return undefined;
			// The loader binds every function-valued member before handing it to
			// the factory; Function.prototype.bind on this proxy must not produce
			// a broken bound function, so hand back a callable directly.
			if (prop === "bind" || prop === "call" || prop === "apply") {
				return () => anything;
			}
			return anything;
		},
		apply() {
			return undefined;
		},
	});
	const base: Record<string, unknown> = {
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand: (name: string, options: unknown) => {
			commands.set(name, options);
		},
		registerTool: (tool: { name: string }) => {
			tools.push(tool);
		},
		setActiveTools: (next: unknown) => {
			activeTools = next;
		},
	};
	const pi = new Proxy(base, {
		get(target, prop) {
			if (typeof prop !== "string") return undefined;
			if (prop === "then") return undefined;
			if (prop in target) return target[prop];
			return anything;
		},
	}) as unknown as DeferredPi;
	const emit = async (event: string, payload: Record<string, unknown> = {}): Promise<unknown[]> => {
		const list = handlers.get(event) ?? [];
		const results: unknown[] = [];
		for (let index = 0; index < list.length; index++) {
			results.push(await list[index]({ type: event, ...payload }, {}));
		}
		return results;
	};
	const observed = () => {
		let count = 0;
		for (const list of handlers.values()) count += list.length;
		return count + commands.size + tools.length + (activeTools === undefined ? 0 : 1);
	};
	return { pi, handlers, commands, tools, emit, observed };
}

async function captureRejection(pending: Promise<unknown>): Promise<Error> {
	try {
		await pending;
	} catch (error) {
		return error as Error;
	}
	throw new Error("expected the deferred attempt to reject");
}

const PI_0_84_3_EVENTS = [
	"project_trust",
	"resources_discover",
	"session_start",
	"session_info_changed",
	"session_before_switch",
	"session_before_fork",
	"session_before_compact",
	"session_compact",
	"session_compact_failed",
	"session_shutdown",
	"session_before_tree",
	"session_tree",
	"context",
	"before_provider_request",
	"before_provider_headers",
	"after_provider_response",
	"before_agent_start",
	"agent_start",
	"agent_end",
	"agent_settled",
	"ui_prompt_start",
	"ui_prompt_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"model_select",
	"thinking_level_select",
	"user_bash",
	"input",
	"tool_call",
	"tool_result",
];

// Fails to compile when the installed Pi version adds extension events that
// the loader does not classify as replay or blocking.
type CoveredEvent = (typeof REPLAY_EVENTS)[number] | (typeof BLOCKING_EVENTS)[number];
type UncoveredEventMustBeNever = [Exclude<ExtensionEvent["type"], CoveredEvent>] extends [never] ? true : never;
const uncoveredEventCheck: UncoveredEventMustBeNever = true;
void uncoveredEventCheck;

register("classifies every Pi 0.84.3 extension event as replay or blocking", () => {
	const covered = new Set<string>([...REPLAY_EVENTS, ...BLOCKING_EVENTS]);
	for (const event of PI_0_84_3_EVENTS) {
		assert.ok(covered.has(event), `unclassified event: ${event}`);
	}
	assert.strictEqual(covered.size, PI_0_84_3_EVENTS.length);
	assert.ok(covered.has("resources_discover"), "resources_discover must be delivered to the real factory");
});

register("delays resources_discover so the real factory paths are aggregated", async () => {
	const { pi, emit } = createFakePi();
	const load = (async () => ({
		default: (runtime: unknown) => {
			(runtime as DeferredPi).on("resources_discover", () => ({ skillPaths: ["/skills/late"] }));
		},
	})) as unknown as DeferredLoad;
	installDeferred(pi, load);
	const results = await emit("resources_discover");
	const aggregated = results.find(
		(result) => result && typeof result === "object" && "skillPaths" in result,
	) as { skillPaths: string[] } | undefined;
	assert.ok(aggregated, "real handler return value must survive the same dispatch");
	assert.deepStrictEqual(aggregated.skillPaths, ["/skills/late"]);
});

register("replays session_start after the factory completes and awaits async handlers", async () => {
	const { pi, emit } = createFakePi();
	const order: string[] = [];
	let replayEvent: unknown;
	const load = (async () => ({
		default: (runtime: unknown) => {
			order.push("factory");
			(runtime as DeferredPi).on("session_start", async (event) => {
				order.push("replay-start");
				replayEvent = event;
				await new Promise((resolve) => setTimeout(resolve, 10));
				order.push("replay-end");
			});
		},
	})) as unknown as DeferredLoad;
	installDeferred(pi, load);
	await emit("session_start", { reason: "startup" });
	await emit("tool_call");
	assert.strictEqual(order[0], "factory");
	assert.deepStrictEqual(order, ["factory", "replay-start", "replay-end"]);
	assert.strictEqual((replayEvent as { type?: string }).type, "session_start");
});

register("contains async replay rejections without failing the install", async () => {
	const { pi, emit, observed } = createFakePi();
	let loadCalls = 0;
	const load: DeferredLoad = async () => {
		loadCalls += 1;
		return {
			default: (runtime: unknown) => {
				(runtime as DeferredPi).on("session_start", async () => {
					throw new Error("replay handler exploded");
				});
			},
		};
	};
	installDeferred(pi, load);
	await emit("session_start");
	const recorded: string[] = [];
	const originalError = console.error;
	console.error = (...parts: unknown[]) => {
		recorded.push(parts.map((part) => String(part)).join(" "));
	};
	try {
		await emit("tool_call");
	} finally {
		console.error = originalError;
	}
	assert.strictEqual(loadCalls, 1);
	assert.ok(observed() > 0);
	assert.ok(
		recorded.some((line) => line.includes("replay session_start failed") && line.includes("replay handler exploded")),
		`replay rejection was not reported: ${recorded.join(" | ")}`,
	);
});

register("cancelled warmup does not load the factory after session_shutdown", async () => {
	const { pi, emit } = createFakePi();
	let loadCalls = 0;
	const load: DeferredLoad = async () => {
		loadCalls += 1;
		return { default: () => undefined };
	};
	installDeferred(pi, load);
	await emit("session_start");
	await emit("session_shutdown");
	await new Promise((resolve) => setTimeout(resolve, 400));
	assert.strictEqual(loadCalls, 0, "warmup timer must be cancelled by session_shutdown");
});

register("installs the provided factory once and reuses it across events", async () => {
	const { pi, emit } = createFakePi();
	let loadCalls = 0;
	let factoryCalls = 0;
	const load: DeferredLoad = async () => {
		loadCalls += 1;
		return {
			default: (runtime: unknown) => {
				factoryCalls += 1;
				return runtime;
			},
		};
	};
	installDeferred(pi, load);
	await emit("tool_call");
	await emit("agent_start");
	assert.strictEqual(loadCalls, 1);
	assert.strictEqual(factoryCalls, 1);
});

register("surfaces the first load error when a retried load resolves a partial namespace", async () => {
	const { pi, emit } = createFakePi();
	const attempts: Array<() => Promise<unknown>> = [
		() => Promise.reject(new Error("Cannot find module 'zod'")),
		() => Promise.resolve({ default: { notAFactory: true } }),
	];
	const load = (async () => {
		const next = attempts.shift();
		if (!next) throw new Error("no queued load attempt");
		return next();
	}) as unknown as DeferredLoad;
	installDeferred(pi, load);
	const error = await captureRejection(emit("tool_call"));
	assert.match(error.message, /does not export a factory/);
	assert.match(error.message, /Cannot find module 'zod'/);
});

register("retries transient load failures and throws the last error", async () => {
	const { pi, emit } = createFakePi();
	let loadCalls = 0;
	const load: DeferredLoad = async () => {
		loadCalls += 1;
		throw new Error("EACCES: transient fs failure");
	};
	installDeferred(pi, load);
	const error = await captureRejection(emit("tool_call"));
	assert.match(error.message, /EACCES: transient fs failure/);
	assert.strictEqual(loadCalls, 3);
});

register("does not re-run the factory after it started executing", async () => {
	const { pi, emit } = createFakePi();
	let loadCalls = 0;
	let factoryCalls = 0;
	const load: DeferredLoad = async () => {
		loadCalls += 1;
		return {
			default: () => {
				factoryCalls += 1;
				throw new Error("factory exploded");
			},
		};
	};
	installDeferred(pi, load);
	const first = await captureRejection(emit("tool_call"));
	assert.match(first.message, /factory exploded/);
	const second = await captureRejection(emit("agent_start"));
	assert.match(second.message, /factory exploded/);
	assert.strictEqual(loadCalls, 1);
	assert.strictEqual(factoryCalls, 1);
});

register("shares one deferred attempt across concurrent blocking events", async () => {
	const { pi, emit } = createFakePi();
	let loadCalls = 0;
	let factoryCalls = 0;
	const load: DeferredLoad = () =>
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
	installDeferred(pi, load);
	await Promise.all([emit("tool_call"), emit("agent_start")]);
	assert.strictEqual(loadCalls, 1);
	assert.strictEqual(factoryCalls, 1);
});

register("dynamic import of the real runtime module yields a callable factory", { timeout: 120000 }, async () => {
	const mod = (await import("../src/index.ts")) as { default: unknown };
	assert.strictEqual(typeof mod.default, "function", "real runtime default export must be a factory");
});

register("installs the real runtime module through the real deferred loader", { timeout: 120000 }, async () => {
	const { pi, emit, observed } = createFakePi();
	const realLoad: DeferredLoad = async () => import("../src/index.ts");
	installDeferred(pi, realLoad);
	// Snapshot after install: the stub wrappers themselves register handlers,
	// so growth beyond this point proves the real factory ran.
	const before = observed();
	let failure: unknown;
	try {
		await emit("tool_call");
	} catch (error) {
		failure = error;
	}
	assert.ok(observed() > before, "real factory must register handlers, commands, or tools");
	if (failure !== undefined) {
		const message = failure instanceof Error ? failure.message : String(failure);
		assert.doesNotMatch(message, /does not export a factory/);
		assert.doesNotMatch(message, /Cannot find module/);
	}
});
