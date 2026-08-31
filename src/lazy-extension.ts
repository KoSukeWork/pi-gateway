import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LOAD_RETRY_DELAYS_MS = [0, 250, 750] as const;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadWithRetry<T>(load: () => Promise<T>, onError?: (error: unknown) => void): Promise<T> {
	let lastError: unknown;
	for (const delayMs of LOAD_RETRY_DELAYS_MS) {
		if (delayMs > 0) await delay(delayMs);
		try {
			return await load();
		} catch (error) {
			onError?.(error);
			lastError = error;
		}
	}
	throw lastError;
}

export const REPLAY_EVENTS = ["session_start"] as const;

export const BLOCKING_EVENTS = [
	"session_shutdown",
	"session_info_changed",
	"session_before_switch",
	"session_before_fork",
	"session_before_tree",
	"session_before_compact",
	"session_compact",
	"session_compact_failed",
	"session_tree",
	"before_agent_start",
	"before_provider_request",
	"before_provider_headers",
	"after_provider_response",
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
	"input",
	"user_bash",
	"tool_call",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"tool_result",
	"model_select",
	"thinking_level_select",
	"context",
] as const;

// Startup events are only registered when the bootstrap declares them via
// installDeferred options. resources_discover runs right after session_start
// on every host startup, so registering it unconditionally would load the
// factory during startup and defeat deferred loading.
export const STARTUP_EVENTS = ["resources_discover", "project_trust"] as const;

type ExtensionFactory = (pi: ExtensionAPI) => unknown;
type CommandHandler = (args: string, ctx: unknown) => unknown;
type CompletionItem = { value: string; label: string; description?: string };
type CompletionsFn = (prefix: string) => CompletionItem[] | null | undefined;

export type DeferredCommand = {
	name: string;
	description: string;
	completions?: Array<string | CompletionItem>;
};

function tryRefreshAutocomplete(pi: ExtensionAPI): void {
	try {
		const ui = (pi as { ui?: { addAutocompleteProvider?: (factory: (provider: unknown) => unknown) => void } }).ui;
		ui?.addAutocompleteProvider?.((provider) => provider);
	} catch {
		// UI is not bound yet, or this is RPC.
	}
}

function filterStaticCompletions(
	items: Array<string | CompletionItem> | undefined,
	prefix: string,
): CompletionItem[] | null {
	if (!items?.length) return null;
	const mapped = items.map((item) => (typeof item === "string" ? { value: item, label: item } : item));
	const hits = mapped.filter((item) => item.value.startsWith(prefix));
	return hits.length > 0 ? hits : null;
}

function wrapRuntimePi(
	pi: ExtensionAPI,
	pending: Map<string, { event: unknown; ctx: unknown }>,
	realCommands: Map<string, CommandHandler>,
	realCompletions: Map<string, CompletionsFn>,
	replayQueue: Array<{ event: string; run: () => unknown }>,
	commitQueue: Array<() => void>,
): ExtensionAPI {
	const origOn = pi.on.bind(pi);
	const origRegisterCommand = pi.registerCommand.bind(pi);
	return new Proxy(pi, {
		get(target, prop, receiver) {
			if (prop === "on") {
				return (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
					commitQueue.push(() => origOn(event as never, handler as never));
					const saved = pending.get(event);
					if (!saved) return;
					replayQueue.push({ event, run: () => handler(saved.event, saved.ctx) });
				};
			}
			if (prop === "registerCommand") {
				return (
					name: string,
					options: {
						handler: CommandHandler;
						description?: string;
						getArgumentCompletions?: CompletionsFn;
					},
				) => {
					realCommands.set(name, options.handler);
					if (typeof options.getArgumentCompletions === "function") {
						realCompletions.set(name, options.getArgumentCompletions);
					}
					commitQueue.push(() => origRegisterCommand(name, options as never));
				};
			}
			const value = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

export function installDeferred(
	pi: ExtensionAPI,
	load: () => Promise<{ default: ExtensionFactory }>,
	options: { commands?: DeferredCommand[]; startupEvents?: ReadonlyArray<(typeof STARTUP_EVENTS)[number]> } = {},
): void {
	const pending = new Map<string, { event: unknown; ctx: unknown }>();
	const realCommands = new Map<string, CommandHandler>();
	const realCompletions = new Map<string, CompletionsFn>();
	const replayQueue: Array<{ event: string; run: () => unknown }> = [];
	const commitQueue: Array<() => void> = [];
	const runtimePi = wrapRuntimePi(pi, pending, realCommands, realCompletions, replayQueue, commitQueue);
	let ready: Promise<unknown> | undefined;
	let warmupTimer: ReturnType<typeof setTimeout> | undefined;

	const ensure = () => {
		if (!ready) {
			let firstLoadError: string | undefined;
			let factoryStarted = false;
			const attempt = loadWithRetry(load, (error) => {
				firstLoadError ??= error instanceof Error ? error.message : String(error);
			})
				.then(async (mod) => {
					if (typeof mod.default !== "function") {
						const cause = firstLoadError
							? `; the first load attempt failed with: ${firstLoadError}`
							: "";
						throw new Error(
							`Extension runtime does not export a factory (default is ${typeof mod.default})${cause}`,
						);
					}
					factoryStarted = true;
					let result: unknown;
					try {
						result = await mod.default(runtimePi);
					} catch (error) {
						if (firstLoadError !== undefined) {
							const message = error instanceof Error ? error.message : String(error);
							throw new Error(`${message}; the first load attempt failed with: ${firstLoadError}`);
						}
						throw error;
					}
					for (const commit of commitQueue) {
						commit();
					}
					for (const replay of replayQueue) {
						try {
							await replay.run();
						} catch (error) {
							// Reported here rather than through Pi's emitError pipeline: the deferred
							// loader has no runner handle, so hosts observe this on stderr only.
							const message = error instanceof Error ? error.stack ?? error.message : String(error);
							console.error(`[pi-lazy-extension] replay ${replay.event} failed: ${message}`);
						}
					}
					tryRefreshAutocomplete(pi);
					return result;
				});
			ready = attempt;
			void attempt.catch((error) => {
				if (ready === attempt && !factoryStarted) ready = undefined;
				const message = error instanceof Error ? error.stack ?? error.message : String(error);
				console.error(`[pi-lazy-extension] deferred install failed: ${message}`);
			});
		}
		return ready;
	};

	for (const command of options.commands ?? []) {
		pi.registerCommand(command.name, {
			description: command.description,
			getArgumentCompletions: (prefix: string) => {
				void ensure();
				const real = realCompletions.get(command.name);
				if (real) return real(prefix) ?? null;
				return filterStaticCompletions(command.completions, prefix) ?? null;
			},
			handler: async (args, ctx) => {
				await ensure();
				const handler = realCommands.get(command.name);
				if (!handler) {
					throw new Error(`/${command.name} failed to load`);
				}
				await handler(args, ctx);
			},
		});
	}

	const on = pi.on as (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;

	for (const event of REPLAY_EVENTS) {
		on(event, (e, ctx) => {
			pending.set(event, { event: e, ctx });
			if (event === "session_start") {
				clearTimeout(warmupTimer);
				warmupTimer = setTimeout(() => {
					warmupTimer = undefined;
					void ensure();
				}, 250);
			}
		});
	}

	for (const event of BLOCKING_EVENTS) {
		on(event, async () => {
			if (event === "session_shutdown") {
				clearTimeout(warmupTimer);
				warmupTimer = undefined;
				if (!ready) return;
			}
			await ensure();
		});
	}
	for (const event of options.startupEvents ?? []) {
		on(event, async () => {
			await ensure();
		});
	}
}
