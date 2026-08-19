import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Events that can fire before a deferred runtime finishes registering.
 * A no-op waiter is installed for each so `for-of` over the live handler list
 * will also run the runtime handler pushed during `await ready`.
 */
const EARLY_EVENTS = [
	"session_start",
	"session_shutdown",
	"session_before_switch",
	"session_before_fork",
	"session_before_compact",
	"session_compact",
	"session_tree",
	"resources_discover",
	"before_agent_start",
	"before_provider_request",
	"before_provider_headers",
	"input",
	"tool_call",
	"tool_result",
	"tool_execution_end",
	"agent_start",
	"agent_end",
	"agent_settled",
	"message_start",
	"message_end",
	"turn_end",
	"model_select",
	"thinking_level_select",
	"context",
] as const;

type ExtensionFactory = (pi: ExtensionAPI) => unknown;
type Starter = () => Promise<unknown>;

const QUEUE_KEY = Symbol.for("pi-certification.lazy-extension.queue");

function getQueue(): Starter[] {
	const g = globalThis as Record<symbol, Starter[] | undefined>;
	g[QUEUE_KEY] ??= [];
	return g[QUEUE_KEY];
}

function startAll(): Promise<unknown[]> {
	return Promise.allSettled(getQueue().map((start) => start()));
}

export function installDeferred(
	pi: ExtensionAPI,
	load: () => Promise<{ default: ExtensionFactory }>,
): void {
	let ready: Promise<unknown> | undefined;
	const ensure = () => {
		if (!ready) {
			ready = load().then((mod) => {
				if (typeof mod.default !== "function") {
					throw new Error("Extension runtime does not export a factory");
				}
				return mod.default(pi);
			});
			void ready.catch((error) => {
				const message = error instanceof Error ? error.stack ?? error.message : String(error);
				console.error(`[pi-lazy-extension] deferred install failed: ${message}`);
			});
		}
		return ready;
	};

	getQueue().push(ensure);

	// Do not compile during factory(). Pi loads extensions sequentially and
	// resourceLoader.reload() awaits after factories — an in-flight jiti
	// compile would still block createAgentSessionRuntime. Kick every queued
	// runtime on the first real event so they compile together instead of
	// one-plugin-at-a-time.
	const on = pi.on as (event: string, handler: () => Promise<void>) => void;
	for (const event of EARLY_EVENTS) {
		on(event, async () => {
			await startAll();
		});
	}
}
