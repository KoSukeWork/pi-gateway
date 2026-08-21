import assert from "node:assert/strict";
import {
	isAgentAlreadyProcessingError,
	routeChatMessage,
	stillWorkingNotice,
} from "../src/prompt-routing.js";

assert.equal(routeChatMessage(false), "prompt");
assert.equal(routeChatMessage(true), "steer");
assert.equal(
	isAgentAlreadyProcessingError(
		new Error(
			'Prompt rejected: {"error":"Agent is already processing. Specify streamingBehavior (\'steer\' or \'followUp\') to queue the message."}',
		),
	),
	true,
);
assert.equal(isAgentAlreadyProcessingError(new Error("Request timeout")), false);
assert.equal(stillWorkingNotice(5 * 60_000), "⏳ 还在处理（已 5 分钟）。完成后会发到这条消息里，不用重发。");
assert.equal(stillWorkingNotice(30_000), "⏳ 还在处理（已 1 分钟）。完成后会发到这条消息里，不用重发。");
console.log("prompt-routing tests passed");
