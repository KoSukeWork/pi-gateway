// src/lazy-extension.ts
var REPLAY_EVENTS = ["session_start", "resources_discover"];
var BLOCKING_EVENTS = [
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
  "context"
];
function tryRefreshAutocomplete(pi) {
  try {
    const ui = pi.ui;
    ui?.addAutocompleteProvider?.((provider) => provider);
  } catch {
  }
}
function wrapRuntimePi(pi, pending, realCommands) {
  const origOn = pi.on.bind(pi);
  const origRegisterCommand = pi.registerCommand.bind(pi);
  return new Proxy(pi, {
    get(target, prop, receiver) {
      if (prop === "on") {
        return (event, handler) => {
          origOn(event, handler);
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
      if (prop === "registerCommand") {
        return (name, options) => {
          realCommands.set(name, options.handler);
          return origRegisterCommand(name, options);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}
function installDeferred(pi, load, options = {}) {
  const pending = /* @__PURE__ */ new Map();
  const realCommands = /* @__PURE__ */ new Map();
  const runtimePi = wrapRuntimePi(pi, pending, realCommands);
  let ready;
  const ensure = () => {
    if (!ready) {
      ready = load().then((mod) => {
        if (typeof mod.default !== "function") {
          throw new Error("Extension runtime does not export a factory");
        }
        return mod.default(runtimePi);
      }).then((result) => {
        tryRefreshAutocomplete(pi);
        return result;
      });
      void ready.catch((error) => {
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        console.error(`[pi-lazy-extension] deferred install failed: ${message}`);
      });
    }
    return ready;
  };
  for (const command of options.commands ?? []) {
    pi.registerCommand(command.name, {
      description: command.description,
      handler: async (args, ctx) => {
        await ensure();
        const handler = realCommands.get(command.name);
        if (!handler) {
          throw new Error(`/${command.name} failed to load`);
        }
        return handler(args, ctx);
      }
    });
  }
  const on = pi.on;
  for (const event of REPLAY_EVENTS) {
    on(event, (e, ctx) => {
      pending.set(event, { event: e, ctx });
      if (event === "session_start") {
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

// src/bootstrap.ts
function bootstrap_default(pi) {
  installDeferred(pi, () => import("./runtime.js"), {
    commands: [{ name: "gateway", description: "Manage Hermes-style messaging gateway" }]
  });
}
export {
  bootstrap_default as default
};
