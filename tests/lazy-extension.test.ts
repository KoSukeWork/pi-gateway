import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { BLOCKING_EVENTS, REPLAY_EVENTS, STARTUP_EVENTS, installDeferred } from "../src/lazy-extension.ts";

const register = test;

type InstallArgs = Parameters<typeof installDeferred>;
type InstallOptions = InstallArgs[2];
type DeferredPi = InstallArgs[0];
type DeferredLoad = InstallArgs[1];
type Handler = (event: unknown, ctx: unknown) => unknown;

// Faithful mini-model of Pi event dispatch: handlers live in arrays and the
// dispatcher iterates the live array, so handlers registered during a dispatch
// are reached by that same dispatch (this is how the deferred loader delivers
// startup and blocking events to the real factory).
function createFakePi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, unknown>();
	const tools: Array<{ name: string }> = [];
	let activeTools: unknown;
	// Anything-proxy: unknown ExtensionAPI members resolve to a callable that
	// tolerates arbitrary member access and calls, so real factories that touch
	// host-provided helpers do not crash the harness. The loader binds every
	// function-valued member before handing it to the factory, so bind/call/
	// apply must hand back a plain callable instead of a broken bound function.
	const anything: unknown = new Proxy(function anything() {}, {
		get(_target, prop) {
			if (prop === "then") return undefined;
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
			if (prop in target) return target[prop];
			// never expose a thenable: the loader awaits the factory result
			if (prop === "then") return undefined;
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

// Baseline: Pi 0.84.4 (36 events). Stock Pi 0.84.3 dispatches 34 of these;
// ui_prompt_start/ui_prompt_end only exist from 0.84.4, so their stubs are
// inert there. resources_discover and project_trust are startup events and are
// registered only when the bootstrap declares them.
const PI_0_84_4_EVENTS = [
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
// the loader does not classify as replay, blocking, or startup.
type CoveredEvent =
	| (typeof REPLAY_EVENTS)[number]
	| (typeof BLOCKING_EVENTS)[number]
	| (typeof STARTUP_EVENTS)[number];
type UncoveredEventMustBeNever = [Exclude<ExtensionEvent["type"], CoveredEvent>] extends [never] ? true : never;
const uncoveredEventCheck: UncoveredEventMustBeNever = true;
void uncoveredEventCheck;

register("classifies every Pi 0.84.4 extension event (0.84.3 ships a 34-event subset)", () => {
	const covered = new Set<string>([...REPLAY_EVENTS, ...BLOCKING_EVENTS, ...STARTUP_EVENTS]);
	for (const event of PI_0_84_4_EVENTS) {
		assert.ok(covered.has(event), `unclassified event: ${event}`);
	}
	assert.strictEqual(covered.size, PI_0_84_4_EVENTS.length);
	assert.ok(!BLOCKING_EVENTS.includes("resources_discover" as never), "resources_discover must stay a startup capability");
	assert.ok(!BLOCKING_EVENTS.includes("project_trust" as never), "project_trust must stay a startup capability");
});

register("startup events do not load the factory synchronously", async () => {
	const { pi, emit } = createFakePi();
	let loadCalls = 0;
	const load: DeferredLoad = async () => {
		loadCalls += 1;
		return { default: () => undefined };
	};
	installDeferred(pi, load);
	await emit("session_start");
	await emit("resources_discover");
	await emit("project_trust");
	// Startup dispatches must complete without blocking on the factory; only
	// the asynchronous session_start warmup may preload it off the hot path.
	assert.strictEqual(loadCalls, 0, "startup dispatches must not eagerly load an undeclared factory");
	await new Promise((resolve) => setTimeout(resolve, 400));
	assert.strictEqual(loadCalls, 1, "session_start warmup still preloads asynchronously");
});

register("declared startup events deliver the real factory into resource discovery", async () => {
	const { pi, handlers, emit } = createFakePi();
	let factoryCalls = 0;
	const load = (async () => ({
		default: (runtime: unknown) => {
			factoryCalls += 1;
			(runtime as DeferredPi).on("resources_discover", () => ({ skillPaths: ["/skills/late"] }));
		},
	})) as unknown as DeferredLoad;
	installDeferred(pi, load, { startupEvents: ["resources_discover"] });
	assert.strictEqual((handlers.get("resources_discover") ?? []).length, 1, "declared startup stub must be registered");
	const results = await emit("resources_discover");
	assert.strictEqual(factoryCalls, 1);
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

register("replays the latest session_start received while an async factory is installing", { timeout: 30000 }, async () => {
	const { pi, emit } = createFakePi();
	const received: string[] = [];
	let releaseFactory!: () => void;
	const gate = new Promise<void>((resolve) => {
		releaseFactory = resolve;
	});
	const load = (async () => ({
		default: async (runtime: unknown) => {
			(runtime as DeferredPi).on("session_start", (event) => {
				received.push(String((event as { name?: string }).name));
			});
			await gate;
		},
	})) as unknown as DeferredLoad;
	installDeferred(pi, load);
	await emit("session_start", { name: "A" });
	const installing = emit("tool_call");
	await new Promise((resolve) => setTimeout(resolve, 20));
	await emit("session_start", { name: "B" });
	releaseFactory();
	await installing;
	assert.deepStrictEqual(received, ["B"], "stale session A must not be replayed after newer session B");
});

register("replays a session_start that first arrives while the factory is installing", { timeout: 30000 }, async () => {
	const { pi, emit } = createFakePi();
	const received: string[] = [];
	let releaseFactory!: () => void;
	const gate = new Promise<void>((resolve) => {
		releaseFactory = resolve;
	});
	const load = (async () => ({
		default: async (runtime: unknown) => {
			(runtime as DeferredPi).on("session_start", (event) => {
				received.push(String((event as { name?: string }).name));
			});
			await gate;
		},
	})) as unknown as DeferredLoad;
	installDeferred(pi, load);
	const installing = emit("tool_call");
	await new Promise((resolve) => setTimeout(resolve, 20));
	await emit("session_start", { name: "B" });
	releaseFactory();
	await installing;
	assert.deepStrictEqual(received, ["B"], "handler registered with empty pending must still receive the later event");
});

register("does not expose deferred command completions when the factory fails", { timeout: 30000 }, async () => {
	const { pi, commands, emit } = createFakePi();
	let completionCalls = 0;
	const load: DeferredLoad = async () => ({
		default: (runtime: unknown) => {
			(runtime as DeferredPi).registerCommand("demo", {
				handler: () => undefined,
				getArgumentCompletions: () => {
					completionCalls += 1;
					return [{ value: "real", label: "real" }];
				},
			} as never);
			throw new Error("factory exploded after registering");
		},
	});
	installDeferred(pi, load, {
		commands: [{ name: "demo", description: "demo command", completions: ["static"] }],
	});
	await captureRejection(emit("tool_call"));
	const stub = commands.get("demo") as { getArgumentCompletions?: (prefix: string) => unknown };
	const result = stub.getArgumentCompletions?.("");
	assert.strictEqual(completionCalls, 0, "completions of a failed factory must stay unexposed");
	assert.deepStrictEqual(result, [{ value: "static", label: "static" }]);
});

register("removes stale completions when a command is replaced without completions", { timeout: 30000 }, async () => {
	const { pi, commands, emit } = createFakePi();
	let firstCalls = 0;
	const load: DeferredLoad = async () => ({
		default: (runtime: unknown) => {
			const rt = runtime as DeferredPi;
			rt.registerCommand("demo", {
				handler: () => undefined,
				getArgumentCompletions: () => {
					firstCalls += 1;
					return [{ value: "first", label: "first" }];
				},
			} as never);
			rt.registerCommand("demo", { handler: () => undefined } as never);
		},
	});
	installDeferred(pi, load, {
		commands: [{ name: "demo", description: "demo command", completions: ["static"] }],
	});
	await emit("tool_call");
	const stub = commands.get("demo") as { getArgumentCompletions?: (prefix: string) => unknown };
	const result = stub.getArgumentCompletions?.("");
	assert.strictEqual(firstCalls, 0, "stale completion must stop being called after replacement");
	assert.strictEqual(
		result,
		undefined,
		"replacement without completions must not expose any completion",
	);
});

register("queues a newer session_start that arrives while replay is awaiting", { timeout: 30000 }, async () => {
	const { pi, emit } = createFakePi();
	const first: string[] = [];
	const second: string[] = [];
	let releaseFirst!: () => void;
	const gate = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const load = (async () => ({
		default: async (runtime: unknown) => {
			const rt = runtime as DeferredPi;
			rt.on("session_start", async (event) => {
				first.push(String((event as { name?: string }).name));
				if ((event as { name?: string }).name === "B") {
					await gate;
				}
			});
			rt.on("session_start", (event) => {
				second.push(String((event as { name?: string }).name));
			});
		},
	})) as unknown as DeferredLoad;
	installDeferred(pi, load);
	await emit("session_start", { name: "B" });
	const installing = emit("tool_call");
	await new Promise((resolve) => setTimeout(resolve, 20));
	await emit("session_start", { name: "C" });
	assert.ok(
		!first.includes("C") && !second.includes("C"),
		`C must queue behind the replay instead of racing live handlers: ${JSON.stringify({ first, second })}`,
	);
	releaseFirst();
	await installing;
	assert.deepStrictEqual(first, ["B", "C"]);
	assert.deepStrictEqual(second, ["B", "C"]);
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
	const { pi, handlers, emit, observed } = createFakePi();
	const realLoad: DeferredLoad = async () => import("../src/index.ts");
	installDeferred(pi, realLoad);
	// Snapshot after install: the stub wrappers themselves register handlers,
	// so growth beyond this point proves the real factory ran.
	const before = observed();
	await emit("tool_call");
	assert.ok(observed() > before, "real factory must register handlers, commands, or tools");
	// Capability cross-check: a factory that never declared resources_discover
	// must not register handlers for it.
	const rdHandlers = (handlers.get("resources_discover") ?? []).length;
	assert.strictEqual(rdHandlers, 0);
});

register("real bootstrap declares matching capabilities and loads the real factory", { timeout: 120000 }, async () => {
	const { pi, handlers, commands, emit, observed } = createFakePi();
	const bootstrap = (await import("../src/bootstrap.ts")).default as (pi: DeferredPi) => unknown;
	await bootstrap(pi);
	for (const name of ["gateway"]) {
		assert.ok(commands.has(name), `bootstrap stub command missing: ${name}`);
	}
	const startupStubs = (handlers.get("resources_discover") ?? []).length;
	assert.strictEqual(startupStubs > 0, false, "bootstrap startupEvents must match the declared capability");
	const before = observed();
	// Factories may re-register a stub command name (same Map key), so track
	// object identity: a swapped options object proves the real factory ran.
	const commandIdentity = new Map(["gateway"].map((name) => [name, commands.get(name)]));
	await emit("tool_call");
	const realigned = ["gateway"].some((name) => commands.get(name) !== commandIdentity.get(name));
	assert.ok(
		realigned || observed() > before,
		"real factory must register or re-register through the loader",
	);
	// After a clean install the factory's own resources_discover handler (for
	// capability repos) has joined the stub: 2 handlers when declared, else 0.
	const rdHandlers = (handlers.get("resources_discover") ?? []).length;
	assert.strictEqual(rdHandlers, 0);
});
