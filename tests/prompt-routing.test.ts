import assert from "node:assert/strict";
import { routeChatMessage } from "../src/prompt-routing.js";

assert.equal(routeChatMessage(false), "prompt");
assert.equal(routeChatMessage(true), "steer");
console.log("prompt-routing tests passed");
