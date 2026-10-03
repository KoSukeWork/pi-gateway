import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installDeferred } from "./lazy-extension.js";
import { isGatewayRpcChild } from "./rpc-child.js";

export default function (pi: ExtensionAPI) {
	if (isGatewayRpcChild()) return;
	installDeferred(pi, () => import("./index.js"), {
		commands: [
			{
				name: "gateway",
				description: "Manage Hermes-style messaging gateway",
				completions: [
					"start",
					"start -d",
					"stop",
					"status",
					"restart",
					"pair",
					"allow",
					"revoke",
					"admin",
					"sessions",
					"tasks",
					"config",
					"tool-policy",
				],
			},
		],
	});
}
