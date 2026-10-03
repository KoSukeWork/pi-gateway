/** Prevent this gateway from registering another gateway inside its own worker. */
export function isGatewayRpcChild(): boolean {
	return process.env.PI_GATEWAY_RPC_CHILD === "1";
}
