import assert from "node:assert/strict";
import { slashInteractionToContent } from "../src/adapters/slash-commands.js";

assert.equal(slashInteractionToContent({ name: "continue" }), "/continue");
assert.equal(slashInteractionToContent({ name: "session" }), "/session");
assert.equal(slashInteractionToContent({ name: "detach" }), "/detach");
assert.equal(slashInteractionToContent({ name: "new" }), "/new");
assert.equal(slashInteractionToContent({ name: "restart" }), "/restart");
assert.equal(slashInteractionToContent({ name: "model" }), "/model");
assert.equal(
	slashInteractionToContent({
		name: "model",
		options: [{ name: "id", value: "Work/grok-4.6" }],
	}),
	"/model Work/grok-4.6",
);
assert.equal(slashInteractionToContent({ name: "unknown" }), null);
console.log("slash-commands tests passed");
