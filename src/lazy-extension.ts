import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Events that can fire before a deferred runtime finishes registering.
 * session_start / resources_discover are recorded and replayed; they must
 * not await the heavy graph or bindExtensions stays blocked for seconds.
 */
const REPLAY_EVENTS = ["session_start", "resources_discover"] as const;

const BLOCKING_EVENTS = [
	"session_shutdown",
	"session_before_switch",
	"session_before_fork",
	"session_before_compact",
	"session_compact",
	"session_tree",
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

function wrapForReplay(
	pi: ExtensionAPI,
	pending: Map<string, { event: unknown; ctx: unknown }>,
): ExtensionAPI {
	const origOn = pi.on.bind(pi);
	return new Proxy(pi, {
		get(target, prop, receiver) {
			if (prop === "on") {
				return (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
					origOn(event as never, handler as never);
					const saved = pending.get(event);
					if (!saved) return;
					try {
						void handler(saved.event, saved.ctx);
					} catch (error) {
						const message = error instanceof Error ? error.stack ?? error.message : String(error);
						console.error(`[pi-lazy-extension] replay ${event} failed: ${message}`);
					}
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
): void {
	const pending = new Map<string, { event: unknown; ctx: unknown }>();
	const runtimePi = wrapForReplay(pi, pending);
	let ready: Promise<unknown> | undefined;

	const ensure = () => {
		if (!ready) {
			ready = load().then((mod) => {
				if (typeof mod.default !== "function") {
					throw new Error("Extension runtime does not export a factory");
				}
				return mod.default(runtimePi);
			});
			void ready.catch((error) => {
				const message = error instanceof Error ? error.stack ?? error.message : String(error);
				console.error(`[pi-lazy-extension] deferred install failed: ${message}`);
			});
		}
		return ready;
	};

	const on = pi.on as (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;

	for (const event of REPLAY_EVENTS) {
		on(event, (e, ctx) => {
			pending.set(event, { event: e, ctx });
			if (event === "session_start") {
				// After bindExtensions / RPC ready. Immediate import() steals the
				// event loop and puts the 10s compile back on the ready path.
				setTimeout(() => {
					void ensure();
				}, 250);
			}
		});
	}

	for (const event of BLOCKING_EVENTS) {
		on(event, async () => {
			if (event === "session_shutdown" && !ready) return;
			await ensure();
		});
	}
}
