import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Import only after selecting an isolated home; never open the user's database.
const temp = mkdtempSync(join(tmpdir(), "gateway-auth-"));
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = temp;
process.env.USERPROFILE = temp;
const auth = await import("../src/security/auth.ts");
try {
	const db = auth.initSecurityStore();
	const code = auth.generatePairingCode("telegram", "test-user");
	const pending = auth.listPendingPairingCodes()[0];
	assert.equal(pending.userId, "test-user");
	assert.ok(pending.createdAt > 0 && pending.expiresIn > 0);
	assert.equal(auth.approvePairingCode(code), true);
	assert.equal(auth.isUserAllowed("telegram", "test-user"), true);
	assert.equal(auth.approvePairingCode(code), false);
	const duplicate = auth.generatePairingCode("telegram", "test-user");
	assert.equal(auth.approvePairingCode(duplicate), true);
	assert.equal(auth.listAllowlistedUsers().length, 1);
	assert.equal(auth.listAllowlistedUsers("telegram")[0].userId, "test-user");
	assert.ok(auth.listAllowlistedUsers()[0].addedAt > 0);
	const expired = auth.generatePairingCode("web", "expired");
	db.prepare("UPDATE pairing_codes SET expires_at = 0 WHERE code = ?").run(expired);
	assert.equal(auth.approvePairingCode(expired), false);
	const rejected = auth.generatePairingCode("web", "rejected");
	db.exec("CREATE TRIGGER reject_allowlist BEFORE INSERT ON allowlist BEGIN SELECT RAISE(ABORT, 'test failure'); END");
	assert.throws(() => auth.approvePairingCode(rejected), /test failure/);
	assert.equal((db.prepare("SELECT used FROM pairing_codes WHERE code = ?").get(rejected) as { used: number }).used, 0);
	db.exec("DROP TRIGGER reject_allowlist");
	assert.equal(auth.approvePairingCode(rejected), true);
	assert.equal(auth.checkRateLimit("client", 1, 1000), true);
	assert.equal(auth.checkRateLimit("client", 1, 1000), false);
	db.prepare("UPDATE rate_limits SET window_start = ? WHERE identifier = ?").run(Date.now() - 2000, "client");
	assert.equal(auth.checkRateLimit("client", 1, 1000), true);
	auth.addAdmin("*", "administrator", "test");
	assert.equal(auth.listAdmins()[0].userId, "administrator");
	assert.ok(auth.listAdmins()[0].addedAt > 0);
	console.log("security auth tests passed");
} finally {
	auth.closeSecurityStore();
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	rmSync(temp, { recursive: true, force: true });
}
