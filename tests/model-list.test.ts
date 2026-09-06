import assert from "node:assert/strict";
import {
	formatModelListText,
	modelListUsesInlineButtons,
} from "../src/model-list.js";

assert.equal(modelListUsesInlineButtons("telegram"), true);
assert.equal(modelListUsesInlineButtons("discord"), false);
assert.equal(modelListUsesInlineButtons("slack"), false);

const text = formatModelListText([
	{ provider: "Work", id: "grok-4.6", name: "Grok 4.6" },
	{ provider: "Work", id: "gpt-5", name: "GPT-5" },
]);
assert.match(text, /^Available models \(2\):/);
assert.match(text, /Work\/grok-4\.6/);
assert.match(text, /Work\/gpt-5/);
assert.match(text, /\/model provider\/id/);
console.log("model-list tests passed");
