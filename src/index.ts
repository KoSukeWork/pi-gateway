/**
 * pi-gateway - Hermes-style Messaging Gateway
 *
 * Architecture:
 * - Single background process
 * - Platform adapters (Discord, Telegram, etc.)
 * - Per-chat session management
 * - Background task support
 * - Security (allowlists, pairing)
 *
 * Usage:
 *   /gateway start [port]    - Start the gateway
 *   /gateway stop           - Stop the gateway
 *   /gateway status         - Show status
 *   /gateway pair <code>    - Approve pairing code
 */

import { join } from "node:path";
import {
	existsSync,
	readFileSync,
	mkdirSync,
	writeFileSync,
	watchFile,
	unwatchFile,
} from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { isLoopbackHost, resolveDaemonInvocation, resolveRpcExtensionPath } from "./runtime-entry.js";
import { buildRpcPiArgs, resolvePiInvocation } from "./resolve-pi.js";
import { isGatewayRpcChild } from "./rpc-child.js";
import { ChatReply } from "./chat-reply.js";
import { agentEndError, agentEndText, AssistantStream } from "./agent-response.js";
import { ownsChatTurn, CHAT_HELP } from "./chat-turn.js";
import {
	formatModelListText,
	modelListUsesInlineButtons,
	parseModelKey,
	type CatalogModel,
} from "./model-list.js";

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import {
	closeSessionStore,
	initSessionStore,
	getOrCreateSession,
	listSessions,
	touchSession,
	deleteSession,
	type SessionConfig,
} from "./sessions/store.js";
import { ensureGatewaySessionFile, gatewaySessionFile } from "./sessions/gateway-session.js";
import {
	clearChannelBinding,
	getChannelBinding,
	publishActiveSession,
	readActiveSession,
	sessionFileAgeMs,
	setChannelBinding,
} from "./sessions/active-session.js";
import {
	buildContinueMessage,
	buildSessionStatusMessage,
} from "./sessions/session-preview.js";
import { parseChatSessionCommand } from "./sessions/chat-commands.js";
import {
	buildNewSessionMessage,
	createProjectSessionFile,
	resolveSessionCwd,
} from "./sessions/new-session.js";
import { ensureDetachedWorkspace } from "./sessions/workspace.js";
import {
	buildResumeAttachedMessage,
	formatResumeList,
	listRecentSessions,
	parseResumeCallback,
	rememberResumeList,
	resumeButtons,
	takeResumeChoice,
} from "./sessions/resume.js";
import { logger } from "./logger.js";
import {
	GATEWAY_CONFIG_DIR,
	GATEWAY_CONFIG_FILE,
	getPackageRoot,
} from "./paths.js";
import {
	createGatewayStatusReport,
	fetchGatewayHealth,
	normalizeGatewayHealthConfig,
	parseGatewayPid,
	removeGatewayPidFile,
	resolveGatewayStatus,
	waitForGatewayHealth,
	waitForSpawnedDaemonHealth,
	writeGatewayPidFile,
} from "./status.js";
import {
	closeSecurityStore,
	initSecurityStore,
	isUserAllowed,
	isAdmin,
	approvePairingCode,
	generatePairingCode,
	listPendingPairingCodes,
	addToAllowlist,
	listAllowlistedUsers,
	revokeUserAccess,
	addAdmin,
	removeAdmin,
	listAdmins,
	type Platform,
} from "./security/auth.js";
import {
	setToolPolicy,
	removeToolPolicy,
	listToolPolicies,
	resetToolPolicies,
	getEffectivePolicySummary,
	buildPolicyGuard,
} from "./security/tool-policy.js";
import {
	closeBackgroundTasks,
	initBackgroundTasks,
	startBackgroundTask,
	getPendingResultsForSession,
	markTaskDelivered,
	listTasks,
} from "./background/manager.js";
import { DiscordAdapter } from "./adapters/discord.js";
import { TwitchAdapter } from "./adapters/twitch.js";
import { TelegramAdapter } from "./adapters/telegram.js";
import { SlackAdapter } from "./adapters/slack.js";
import { WhatsAppAdapter } from "./adapters/whatsapp.js";
import type {
	BaseAdapter,
	AdapterCallbacks,
	PlatformMessage,
	InteractiveResponse,
} from "./adapters/base.js";
import {
	handleExtensionUiRequest,
	handleInteractiveResponse,
	setStdinWriter,
	setActiveChannel,
	getActiveChannel,
	setStreamRedirectHandler,
	setFlushHandler,
	cleanupPendingUiRequests,
	cancelUiRequest,
	isDialogUiMethod,
	tryConsumeTextReply,
} from "./interactive.js";

// Types
interface GatewayConfig {
	port: number;
	host: string;
	tokens: string[];
	corsOrigins: string[];
	enableWebSocket: boolean;
	enableHttp: boolean;
	security: {
		allowAll: boolean;
		requirePairing: boolean;
		allowedUids: Record<string, string[]>;
		adminUids: Record<string, string[]>;
		rateLimit: {
			maxRequests: number;
			windowMs: number;
		};
	};
	/** Timeout in ms for waiting on pi agent to respond (default: 300000 = 5 min) */
	promptTimeoutMs?: number;
	sessions: {
		resetPolicy: "daily" | "idle" | "both";
		dailyHour: number;
		idleMinutes: number;
	};
	platforms: {
		discord?: {
			enabled: boolean;
			botToken: string;
			guildId?: string;
			allowedChannels?: string[];
			allowedRoles?: string[];
			requireMention?: boolean;
			reactions?: boolean;
		};
		twitch?: {
			enabled: boolean;
			clientId: string;
			clientSecret: string;
			channels?: string[];
		};
		telegram?: {
			enabled: boolean;
			token: string;
			/** Public URL for Telegram webhook (e.g. https://example.com/webhook/telegram).
			 *  When omitted, long polling is used automatically. */
			webhookUrl?: string;
		};
		slack?: {
			enabled: boolean;
			webhookUrl?: string;
			botToken?: string;
		};
		whatsapp?: {
			enabled: boolean;
			sessionPath?: string;
			printQr?: boolean;
		};
	};
}

interface GatewayState {
	running: boolean;
	adapters: Map<string, BaseAdapter>;
	clients: Map<string, WebSocket>;
	sessions: Map<string, SessionConfig>;
}

const DEFAULT_CONFIG: GatewayConfig = {
	port: 3847,
	host: "localhost",
	tokens: [],
	corsOrigins: [],
	enableWebSocket: true,
	enableHttp: true,
	security: {
		allowAll: false,
		requirePairing: false,
		allowedUids: {},
		adminUids: {},
		rateLimit: { maxRequests: 60, windowMs: 60000 },
	},
	sessions: {
		resetPolicy: "idle",
		dailyHour: 4,
		idleMinutes: 1440,
	},
	promptTimeoutMs: 300000, // still-working notice interval; 0 disables. Completions wait until agent_end.
	platforms: {},
};

let config: GatewayConfig;
let state: GatewayState;
let server: ReturnType<typeof createServer> | null = null;
let wss: WebSocketServer | null = null;
let rpcProcess: ReturnType<typeof spawn> | null = null;
let rpcBoundSessionFile: string | null = null;
let globalCtx: ExtensionContext | null = null;
let cronInterval: ReturnType<typeof setInterval> | null = null;
let statusRefreshInterval: ReturnType<typeof setInterval> | null = null;
let lastGatewayStatusText: string | null = null;
let statusUpdateGeneration = 0;
let lastDetachedHealthConfig: GatewayConfig | null = null;
let configReloadQueue = Promise.resolve();
let daemonShuttingDown = false;

const STATUS_REFRESH_INTERVAL_MS = 2000;

// PID file for detached daemon mode
const PID_FILE = join(GATEWAY_CONFIG_DIR, "gateway.pid");

function readDaemonPid(): number | null {
	if (!existsSync(PID_FILE)) return null;

	let rawPid: string;
	try {
		rawPid = readFileSync(PID_FILE, "utf-8").trim();
	} catch {
		return null;
	}

	const pid = parseGatewayPid(rawPid);
	if (pid === null) return null;

	try {
		process.kill(pid, 0);
		return pid;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EPERM") return pid;
		removeGatewayPidFile(PID_FILE, pid);
		return null;
	}
}

// Pending RPC requests
interface PendingRequest {
	id: string;
	resolve: (msg: unknown) => void;
	reject: (err: Error) => void;
	timer?: ReturnType<typeof setTimeout>;
}
const pendingRequests: PendingRequest[] = [];

// Pending prompt completions — resolve when agent_end arrives with response text
interface PendingCompletion {
	resolve: (text: string) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setInterval> | null;
	/** Called with accumulated streaming text as deltas arrive */
	onStream?: (text: string) => void;
	onSlow?: (elapsedMs: number) => void;
	/** Accumulated streamed text from text_delta events */
	streamedText: string;
	stream: AssistantStream;
	onEvent?: (event: Record<string, any>) => void;
	agentEnd?: Record<string, any>;
	agentStarted?: boolean;
	inflightInputs?: number;
	deferredSettlement?: boolean;
	settlementProbeTimer?: ReturnType<typeof setTimeout>;
}
const pendingCompletions: PendingCompletion[] = [];
let rpcTurnActive = false;
let activeChatTurn: {
	message: PlatformMessage;
	kind: "prompt" | "command";
	reply?: ChatReply;
	stopping: boolean;
	queued: string[];
	phase: "preparing" | "running" | "delivering";
	deferred: PlatformMessage[];
} | null = null;

function clearCompletionTimer(completion: PendingCompletion): void {
	if (completion.timer) clearInterval(completion.timer);
	completion.timer = null;
	clearTimeout(completion.settlementProbeTimer);
	completion.settlementProbeTimer = undefined;
}

async function settleDeferredRpcTurn(completion: PendingCompletion): Promise<void> {
	if (pendingCompletions[0] !== completion || completion.inflightInputs || !completion.deferredSettlement) return;
	try {
		const state = await sendRpc("get_state") as { success?: boolean; data?: { isStreaming?: boolean; isCompacting?: boolean } };
		if (!state.success) throw new Error("Could not query follow-up state");
		if (pendingCompletions[0] !== completion || completion.inflightInputs || !completion.deferredSettlement) return;
		if (state.data?.isStreaming === false && state.data.isCompacting === false) settleRpcTurn(completion.agentEnd ?? { messages: [] });
	} catch (error) {
		// Submission already succeeded. A failed idle probe must not say input was rejected.
		logger.warn("[gateway] Could not settle acknowledged follow-up; will retry state probe:", error);
		if (pendingCompletions[0] === completion && !completion.settlementProbeTimer) {
			completion.settlementProbeTimer = setTimeout(() => {
				completion.settlementProbeTimer = undefined;
				void settleDeferredRpcTurn(completion);
			}, 1000);
		}
	}
}

function settleRpcTurn(event: Record<string, any>): void {
	const pending = pendingCompletions[0];
	if (pending?.inflightInputs) {
		pending.agentEnd = event;
		pending.deferredSettlement = true;
		return;
	}
	rpcTurnActive = false;
	const active = getActiveChannel();
	const completion = pendingCompletions.shift();
	const text = completion?.stream.finalText(event) ?? agentEndText(event);
	if (completion) {
		const error = agentEndError(event);
		if (error) { completion.onStream?.(text); completion.reject(new Error(error)); }
		else completion.resolve(text);
	} else if (text.trim() && active) {
		state.adapters.get(active.platform)?.sendMessage(active.channelId, text).catch((error) => {
			logger.error("[gateway] Failed to deliver orphan terminal event:", error);
		});
	}
	cleanupPendingUiRequests();
	setActiveChannel(null);
}

function rejectPendingRpc(error: Error): void {
	rpcTurnActive = false;
	while (pendingCompletions.length) pendingCompletions.shift()!.reject(error);
	while (pendingRequests.length) {
		const request = pendingRequests.shift()!;
		clearTimeout(request.timer);
		request.reject(error);
	}
}

// Load/save config
function mergeGatewayConfig(value: unknown): GatewayConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Gateway config must be a JSON object");
	}
	const parsed = value as Partial<GatewayConfig>;
	const healthConfig = normalizeGatewayHealthConfig(parsed);
	if (!healthConfig) throw new Error("Invalid gateway host, port, or tokens");
	if (
		parsed.security === null ||
		(parsed.security !== undefined &&
			(typeof parsed.security !== "object" || Array.isArray(parsed.security)))
	) {
		throw new Error("config.security must be an object");
	}
	if (
		parsed.sessions === null ||
		(parsed.sessions !== undefined &&
			(typeof parsed.sessions !== "object" || Array.isArray(parsed.sessions)))
	) {
		throw new Error("config.sessions must be an object");
	}

	const security: Partial<GatewayConfig["security"]> = parsed.security ?? {};
	const sessions: Partial<GatewayConfig["sessions"]> = parsed.sessions ?? {};
	const rateLimit: Partial<GatewayConfig["security"]["rateLimit"]> =
		security.rateLimit ?? {};
	const merged = {
		...DEFAULT_CONFIG,
		...parsed,
		...healthConfig,
		security: {
			...DEFAULT_CONFIG.security,
			...security,
			rateLimit: { ...DEFAULT_CONFIG.security.rateLimit, ...rateLimit },
		},
		sessions: { ...DEFAULT_CONFIG.sessions, ...sessions },
		platforms: { ...DEFAULT_CONFIG.platforms, ...(parsed.platforms ?? {}) },
	} as GatewayConfig;

	if (!(["daily", "idle", "both"] as string[]).includes(merged.sessions.resetPolicy)) {
		throw new Error("Invalid sessions.resetPolicy");
	}
	if (
		!Number.isInteger(merged.sessions.dailyHour) ||
		merged.sessions.dailyHour < 0 ||
		merged.sessions.dailyHour > 23 ||
		!Number.isFinite(merged.sessions.idleMinutes) ||
		merged.sessions.idleMinutes <= 0
	) {
		throw new Error("Invalid session reset timing");
	}
	return merged;
}

function loadConfig(): GatewayConfig {
	try {
		if (!existsSync(GATEWAY_CONFIG_FILE)) {
			const packageRoot = getPackageRoot(import.meta.url);
			const defaultConfigPath = join(
				packageRoot,
				"config",
				"config.default.json",
			);
			if (existsSync(defaultConfigPath)) {
				mkdirSync(GATEWAY_CONFIG_DIR, { recursive: true });
				const seeded = JSON.parse(readFileSync(defaultConfigPath, "utf-8"));
				if (!Array.isArray(seeded.tokens) || seeded.tokens.length === 0) {
					seeded.tokens = [randomBytes(24).toString("base64url")];
				}
				if (!seeded.security || typeof seeded.security !== "object") {
					seeded.security = {};
				}
				seeded.security.allowAll = false;
				writeFileSync(
					GATEWAY_CONFIG_FILE,
					`${JSON.stringify(seeded, null, 2)}\n`,
				);
				logger.info("[gateway] Seeded default config at", GATEWAY_CONFIG_FILE);
			}
		}
		if (existsSync(GATEWAY_CONFIG_FILE)) {
			return mergeGatewayConfig(
				JSON.parse(readFileSync(GATEWAY_CONFIG_FILE, "utf-8")),
			);
		}
	} catch (err) {
		logger.error(
			"[gateway] Failed to parse config file — using defaults. Error:",
			err,
		);
	}
	return mergeGatewayConfig({});
}

// Token auth
function verifyToken(token: string): boolean {
	if (config.tokens.length === 0) {
		// Empty token list is only a convenience on loopback. Binding a public
		// interface without tokens must fail closed.
		return isLoopbackHost(config.host);
	}
	return config.tokens.includes(token);
}

function authenticate(req: IncomingMessage): boolean {
	const auth = req.headers.authorization;
	if (!auth) return verifyToken("");
	if (auth.startsWith("Bearer ")) return verifyToken(auth.slice(7));
	return false;
}

// WebSocket helpers
function sendWs(ws: WebSocket, msg: object): void {
	if (ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify(msg));
	}
}

function broadcastClients(event: string, data: unknown): void {
	for (const ws of state.clients.values()) {
		sendWs(ws, { type: event, data });
	}
}

// RPC to pi agent
function createRpcProcess(): any {
	rpcBoundSessionFile = null;
	const extensionPath = resolveRpcExtensionPath(import.meta.url);
	const invocation = resolvePiInvocation(buildRpcPiArgs(extensionPath));
	logger.info(
		`[gateway] Starting pi RPC: ${invocation.command} ${invocation.args.join(" ")}`,
	);
	const proc = spawn(invocation.command, invocation.args, {
		stdio: ["pipe", "pipe", "pipe"],
		cwd: process.cwd(),
		env: {
			...process.env,
			PI_GATEWAY_RPC_CHILD: "1",
			OLLAMA_HOST: process.env.OLLAMA_HOST || "localhost:11434",
		},
	});
	proc.on("error", (error) => {
		logger.error("[gateway] Failed to start pi RPC process:", error);
		if (rpcProcess === proc) {
			rejectPendingRpc(error);
			rpcProcess = null;
		}
	});

	// Give the interactive bridge a way to write to pi's stdin
	setStdinWriter((line: string) => {
		if (proc.stdin?.writable) {
			proc.stdin.write(line);
		}
	});

	function handleRpcLine(line: string): void {
		if (!line) return;
		try {
			const msg = JSON.parse(line);
			pendingCompletions[0]?.onEvent?.(msg);
			if (msg.type === "agent_start") {
				rpcTurnActive = true;
				if (pendingCompletions[0]) {
					pendingCompletions[0].agentStarted = true;
					pendingCompletions[0].deferredSettlement = false;
				}
			}

			if (msg.id) {
				const idx = pendingRequests.findIndex((r) => r.id === msg.id);
				if (idx !== -1) {
					const req = pendingRequests.splice(idx, 1)[0];
					clearTimeout(req.timer);
					req.resolve(msg);
				}
			}

			// Modern Pi may retry/compact/continue after agent_end. Hold ownership until agent_settled.
			if (msg.type === "agent_end") {
				if (pendingCompletions[0]) pendingCompletions[0].agentEnd = msg;
				// Older RPC protocols do not emit the willRetry/agent_settled pair.
				if (typeof msg.willRetry !== "boolean") settleRpcTurn(msg);
			} else if (msg.type === "agent_settled") {
				settleRpcTurn(pendingCompletions[0]?.agentEnd ?? { messages: [] });
			}

			// Handle extension UI requests (select, confirm, input, etc.)
			if (msg.type === "extension_ui_request") {
				const active = getActiveChannel();
				const adapter = active
					? state.adapters.get(active.platform)
					: undefined;
				if (adapter) {
					// Desktop footer/composer updates belong in the live reply, not separate chat messages.
					if (!pendingCompletions[0]?.onEvent || !["setStatus", "setWidget", "setTitle"].includes(msg.method)) handleExtensionUiRequest(msg, adapter).catch((err) => {
						logger.error(
							"[gateway] Failed to handle extension UI request:",
							err,
						);
						if (isDialogUiMethod(msg.method)) {
							cancelUiRequest(msg.id);
						}
					});
				} else if (isDialogUiMethod(msg.method)) {
					logger.warn(
						"[gateway] No adapter for extension UI request — cancelling so Pi cannot hang",
					);
					cancelUiRequest(msg.id);
				}
			}

			// Stream text deltas to active completion
			const completion = pendingCompletions[0];
			const streamed = completion?.stream.consume(msg);
			if (completion && streamed !== null && streamed !== undefined) {
				completion.streamedText = streamed;
				completion.onStream?.(streamed);
			}

			// Broadcast events
			if (msg.type === "response") {
				broadcastClients("response", msg);
			} else {
				broadcastClients("event", msg);
			}
		} catch {
			logger.warn("[gateway] Failed to parse RPC line:", line.slice(0, 200));
		}
	}

	const stdoutDecoder = new TextDecoder();
	let lineBuffer = "";
	proc.stdout?.on("data", (data: Buffer) => {
		if (rpcProcess !== proc) return;
		lineBuffer += stdoutDecoder.decode(data, { stream: true });
		const lines = lineBuffer.split("\n");
		lineBuffer = lines.pop() || "";
		for (const line of lines) handleRpcLine(line);
	});

	proc.stderr?.on("data", (data: Buffer) => {
		logger.info("[gateway] pi stderr:", data.toString().trim());
	});

	proc.on("exit", (code: number) => {
		logger.info(`[gateway] pi process exited with code ${code}`);
	});
	// 'exit' can precede the last stdout data; 'close' means all stdio has drained.
	proc.on("close", (code: number) => {
		if (rpcProcess !== proc) return;
		// Use the same event handler for an unterminated last RPC line.
		lineBuffer += stdoutDecoder.decode();
		if (lineBuffer.trim()) handleRpcLine(lineBuffer.trim());
		rejectPendingRpc(new Error(`pi process exited with code ${code}`));
		// Clean up any pending interactive UI requests
		cleanupPendingUiRequests();
		setActiveChannel(null);
		rpcProcess = null;
		rpcBoundSessionFile = null;
		broadcastClients("agent_disconnected", { code });
	});

	return proc;
}

async function switchRpcSession(sessionFile: string): Promise<void> {
	if (!existsSync(sessionFile)) {
		throw new Error(`Session file not found: ${sessionFile}`);
	}
	if (rpcBoundSessionFile === sessionFile) return;
	const result = (await sendRpc("switch_session", { sessionPath: sessionFile })) as {
		success?: boolean;
		data?: { cancelled?: boolean };
		error?: string;
	};
	if (!result.success) {
		throw new Error(result.error || "switch_session failed");
	}
	if (result.data?.cancelled) {
		throw new Error("switch_session was cancelled by an extension");
	}
	rpcBoundSessionFile = sessionFile;
}

async function sendRpc(
	command: string,
	data: Record<string, unknown> = {},
): Promise<unknown> {
	if (!rpcProcess) throw new Error("pi agent not running");

	const id = randomBytes(8).toString("hex");
	const payload = { id, type: command, ...data };

	return new Promise((resolve, reject) => {
		// Pi emits these ACKs after extension preflight. Human dialogs have their own
		// timeout; a fixed 30s ACK deadline must not cancel a still-valid question.
		const waitsForPreflight = ["prompt", "switch_session", "set_model"].includes(command);
		const timer = waitsForPreflight ? undefined : setTimeout(() => {
			const idx = pendingRequests.findIndex((r) => r.id === id);
			if (idx !== -1) {
				pendingRequests.splice(idx, 1);
				reject(new Error("Request timeout"));
			}
		}, 30000);
		pendingRequests.push({ id, resolve, reject, timer });

		try {
			rpcProcess.stdin.write(JSON.stringify(payload) + "\n");
		} catch (err) {
			clearTimeout(timer);
			const idx = pendingRequests.findIndex((r) => r.id === id);
			if (idx !== -1) pendingRequests.splice(idx, 1);
			reject(err);
		}

	});
}

// Send a prompt to pi and wait for agent_end to get the full response text.
// Unlike sendRpc (which resolves with the ACK), this resolves with the
// actual assistant response text after the agent finishes processing.
// If onStream is provided, it is called with accumulated text as deltas arrive.
function isAgentBusy(): boolean {
	return pendingCompletions.length > 0 || rpcTurnActive;
}

async function sendSteerRpc(message: string): Promise<void> {
	const completion = pendingCompletions[0];
	if (!completion) throw new Error("The model turn already ended");
	completion.inflightInputs = (completion.inflightInputs ?? 0) + 1;
	try {
		// Pi decides atomically: steer while streaming, start a prompt if it already ended.
		// A bare steer after agent_settled would leave the input stranded in Pi's queue.
		const ackResponse = await sendRpc("prompt", { message, streamingBehavior: "steer" });
		const ack = ackResponse as Record<string, unknown>;
		if (!ack.success) throw new Error(`Follow-up rejected: ${JSON.stringify(ackResponse)}`);
		logger.info("[gateway] Follow-up ACK received");
	} finally {
		completion.inflightInputs = (completion.inflightInputs ?? 1) - 1;
		// A handled input can emit no agent events; a newly started model can settle
		// before its ACK arrives. Probe only after all preflights acknowledged.
		await settleDeferredRpcTurn(completion);
	}
}

async function sendPromptRpc(
	message: string,
	onStream?: (text: string) => void,
	onSlow?: (elapsedMs: number) => void,
	onEvent?: (event: Record<string, any>) => void,
): Promise<string> {
	if (!rpcProcess) throw new Error("pi agent not running");
	// Register before writing: ACK, text, and agent_end can share one stdout chunk.
	rpcTurnActive = true;
	const startedAt = Date.now();
	return new Promise((resolve, reject) => {
		const completion: PendingCompletion = {
			resolve: (text) => { clearCompletionTimer(completion); resolve(text); },
			reject: (error) => { clearCompletionTimer(completion); reject(error); },
			timer: null,
			onStream, onSlow, onEvent,
			streamedText: "",
			stream: new AssistantStream(),
		};
		const noticeMs = config.promptTimeoutMs ?? 300000;
		if (noticeMs > 0 && onSlow) completion.timer = setInterval(() => completion.onSlow?.(Date.now() - startedAt), noticeMs);
		pendingCompletions.push(completion);
		sendRpc("prompt", { message }).then(async (response: any) => {
			if (!response.success) throw new Error(`Prompt rejected: ${JSON.stringify(response)}`);
			// An input handler can consume a prompt without starting the agent or emitting agent_end.
			if (!pendingCompletions.includes(completion) || completion.agentStarted) return;
			const state = await sendRpc("get_state") as { success?: boolean; data?: { isStreaming?: boolean; isCompacting?: boolean } };
			if (pendingCompletions[0] === completion && !completion.agentStarted && state.success && state.data?.isStreaming === false && state.data.isCompacting === false) {
				settleRpcTurn({ messages: [] });
			}
		}).catch((error) => {
			const index = pendingCompletions.indexOf(completion);
			if (index < 0) return; // A terminal event already settled this turn.
			pendingCompletions.splice(index, 1);
			rpcTurnActive = false;
			completion.reject(error);
		});
	});
}

const adapterCallbacks: AdapterCallbacks = {
	onMessage: async (message: PlatformMessage) => {

		// Check allowlist
		if (!isUserAllowed(message.platform as Platform, message.userId)) {
			logger.info(`[gateway] User ${message.userId} not in allowlist`);
			const adapter = state.adapters.get(message.platform);
			if (adapter) {
				try {
					await adapter.sendMessage(
						message.channelId,
						"You are not allowed to use this agent. Contact the administrator to request access.",
					);
				} catch (error) {
					logger.error("[gateway] Failed to send allowlist rejection:", error);
				}
			}
			return;
		}

		// Get or create session for this chat
		const session = getOrCreateSession(
			message.platform,
			message.channelId,
			message.userId,
			{
				resetPolicy: config.sessions.resetPolicy,
				dailyHour: config.sessions.dailyHour,
				idleMinutes: config.sessions.idleMinutes,
			},
		);


		// Store session reference
		state.sessions.set(`${message.platform}:${message.channelId}`, session);

		const sessionCmd = message.content.trim();
		if (
			!/^\/(help|stop|abort|new|detach|continue|resume|session|model|restart)(?:\s|$)/i.test(sessionCmd) &&
			tryConsumeTextReply(
				message.platform,
				message.channelId,
				message.content,
				message.userId,
				typeof message.metadata?.replyToMessageId === "string" ? message.metadata.replyToMessageId : undefined,
			)
		) {
			return;
		}
		const adapterForCommand = state.adapters.get(message.platform);
		if (/^\/help$/i.test(sessionCmd)) {
			await adapterForCommand?.sendMessage(message.channelId, CHAT_HELP);
			return;
		}
		if (/^\/(stop|abort)$/i.test(sessionCmd)) {
			const turn = activeChatTurn;
			if (!turn || turn.kind !== "prompt") {
				await adapterForCommand?.sendMessage(message.channelId, "当前没有正在执行的聊天任务。");
				return;
			}
			if (!ownsChatTurn(turn.message, message) && !isAdmin(message.platform as Platform, message.userId)) {
				await adapterForCommand?.sendMessage(message.channelId, "只有任务发起者或管理员可以停止当前任务。");
				return;
			}
			turn.stopping = true;
			turn.reply?.stopping();
			cleanupPendingUiRequests();
			try {
				if (isAgentBusy()) {
					const result = await sendRpc("abort") as { success: boolean; error?: string };
					if (!result.success) throw new Error(result.error || "停止请求失败");
				}
				if (!message.metadata?.stopButton) await adapterForCommand?.sendMessage(message.channelId, "🛑 已请求停止，本轮结束后可以继续发消息。");
			} catch (error) {
				turn.stopping = false;
				turn.reply?.cancelStop();
				await adapterForCommand?.sendMessage(message.channelId, "❌ 停止失败，请稍后再试，或让管理员 /restart。");
			}
			return;
		}
		const privilegedRestart = /^\/restart$/i.test(sessionCmd) && isAdmin(message.platform as Platform, message.userId);
		const readOnlySession = /^\/session$/i.test(sessionCmd);
		if ((activeChatTurn || isAgentBusy()) && !privilegedRestart && !readOnlySession) {
			const turn = activeChatTurn;
			if (turn?.kind === "prompt" && !turn.stopping && ownsChatTurn(turn.message, message) && !sessionCmd.startsWith("/") && !sessionCmd.startsWith("Callback:")) {
				let notice: string;
				try {
					if (isAgentBusy() && pendingCompletions[0]?.agentStarted) {
						await sendSteerRpc(message.content);
						notice = "↪️ 已收到补充要求，本轮会按这个调整。";
					} else if (turn.phase === "preparing") {
						turn.queued.push(message.content);
						notice = "↪️ 已收到补充要求，本轮会按这个调整。";
					} else {
						turn.deferred.push(message);
						notice = isAgentBusy()
							? "↪️ 当前正在处理扩展输入，补充已排队；本轮结束后会启动下一轮。"
							: "↪️ 本轮模型已结束，补充已排队；回复发送完成后会启动下一轮。";
					}
				} catch (error) {
					await adapterForCommand?.sendMessage(message.channelId, "❌ 补充要求未提交，请等当前任务结束后重试。");
					return;
				}
				await adapterForCommand?.sendMessage(message.channelId, notice).catch((error) => logger.warn("[gateway] Follow-up accepted but acknowledgement delivery failed:", error));
			} else await adapterForCommand?.sendMessage(message.channelId, "⏳ 当前任务还在执行，请结束后再操作。任务发起者可补充要求或使用 /stop。");
			return;
		}
		// Reserve synchronously before session switching or Discord REST awaits.
		const isGatewayCommand = !!parseChatSessionCommand(sessionCmd) || /^\/model(?:\s|$)/i.test(sessionCmd) || /^\/restart$/i.test(sessionCmd) || sessionCmd.startsWith("Callback:");
		const reservedTurn = activeChatTurn ? null : {
			message, kind: isGatewayCommand ? "command" as const : "prompt" as const,
			stopping: false, queued: [] as string[], reply: undefined as ChatReply | undefined,
			phase: "preparing" as "preparing" | "running" | "delivering", deferred: [] as PlatformMessage[],
		};
		if (reservedTurn) {
			activeChatTurn = reservedTurn;
			// Session/model hooks may ask questions before the model turn starts.
			setActiveChannel({ platform: message.platform, channelId: message.channelId, userId: message.userId });
		}
		try {
			const resumeCallbackIndex = parseResumeCallback(sessionCmd);
			const sessionCommand = parseChatSessionCommand(sessionCmd);
			if (resumeCallbackIndex !== null || sessionCommand) {
				const adapter = state.adapters.get(message.platform);
				if (!rpcProcess) {
					if (adapter) await adapter.sendMessage(message.channelId, "Agent not running.");
					return;
				}
				const resumeIndex =
					resumeCallbackIndex !== null
						? resumeCallbackIndex
						: sessionCommand?.name === "resume" && sessionCommand.index
							? sessionCommand.index - 1
							: null;
				if (resumeCallbackIndex !== null || sessionCommand?.name === "resume") {
					if (!isAdmin(message.platform as Platform, message.userId)) {
						if (adapter) {
							await adapter.sendMessage(
								message.channelId,
								"Only admins can resume a session.",
							);
						}
						return;
					}
					if (resumeIndex !== null) {
						let choice = takeResumeChoice(
							message.platform,
							message.channelId,
							resumeIndex,
							Date.now(),
							typeof message.metadata?.callbackMessageId === "string" ? message.metadata.callbackMessageId : undefined,
						);
						if (choice.ok === false && resumeCallbackIndex === null) {
							const sessions = listRecentSessions({
								rpcSessionDir: join(GATEWAY_CONFIG_DIR, "rpc-sessions"),
							});
							if (resumeIndex >= 0 && resumeIndex < sessions.length) {
								choice = { ok: true, sessionFile: sessions[resumeIndex].sessionFile };
							}
						}
						if (choice.ok === false) {
							if (adapter) await adapter.sendMessage(message.channelId, choice.error);
							return;
						}
						try {
							await switchRpcSession(choice.sessionFile);
							setChannelBinding(
								message.platform,
								message.channelId,
								choice.sessionFile,
							);
							const age = sessionFileAgeMs(choice.sessionFile);
							if (adapter) {
								await adapter.sendMessage(
									message.channelId,
									buildResumeAttachedMessage(
										choice.sessionFile,
										age !== null && age < 15_000,
									),
								);
							}
						} catch (error) {
							logger.error("[gateway] Failed to resume session:", error);
							if (adapter) {
								await adapter.sendMessage(
									message.channelId,
									`Failed to resume: ${error instanceof Error ? error.message : String(error)}`,
								);
							}
						}
						return;
					}
					const active = readActiveSession();
					const bound = getChannelBinding(message.platform, message.channelId);
					const sessions = listRecentSessions({
						rpcSessionDir: join(GATEWAY_CONFIG_DIR, "rpc-sessions"),
						boundFile: bound?.sessionFile ?? null,
						activeFile: active?.sessionFile ?? null,
					});
					rememberResumeList(
						message.platform,
						message.channelId,
						sessions.map((session) => session.sessionFile),
					);
					const listText = formatResumeList(sessions, {
						boundFile: bound?.sessionFile ?? null,
						activeFile: active?.sessionFile ?? null,
					});
					if (adapter) {
						const withButtons = adapter as {
							sendButtons?: (
								ch: string,
								text: string,
								btns: Array<Array<{ text: string; data: string }>>,
								ownerUserId?: string,
							) => Promise<string>;
						};
						const buttons = resumeButtons(sessions);
						if (withButtons.sendButtons && buttons.length > 0) {
							const pickerId = await withButtons.sendButtons(
								message.channelId,
								listText,
								buttons,
								message.userId,
							);
							if (message.platform === "discord") rememberResumeList(message.platform, message.channelId, sessions.map((session) => session.sessionFile), Date.now(), pickerId);
						} else {
							await adapter.sendMessage(message.channelId, listText);
						}
					}
					return;
				}
				if (!sessionCommand) return;
				if (sessionCommand.name === "session") {
					const active = readActiveSession();
					const bound = getChannelBinding(message.platform, message.channelId);
					if (adapter) {
						await adapter.sendMessage(
							message.channelId,
							buildSessionStatusMessage({
								boundFile: bound?.sessionFile ?? (existsSync(gatewaySessionFile(session.id)) ? gatewaySessionFile(session.id) : null),
								active,
							}),
						);
					}
					return;
				}
				if (sessionCommand.name === "new" && sessionCommand.path) {
					if (!isAdmin(message.platform as Platform, message.userId)) {
						if (adapter) {
							await adapter.sendMessage(
								message.channelId,
								"Only admins can start a conversation in another folder.",
							);
						}
						return;
					}
					const resolved = resolveSessionCwd(sessionCommand.path);
					if (resolved.ok === false) {
						if (adapter) await adapter.sendMessage(message.channelId, resolved.error);
						return;
					}
					try {
						const sessionFile = createProjectSessionFile(resolved.cwd);
						await switchRpcSession(sessionFile);
						setChannelBinding(message.platform, message.channelId, sessionFile);
						if (adapter) {
							await adapter.sendMessage(
								message.channelId,
								buildNewSessionMessage({ sessionFile, cwd: resolved.cwd }),
							);
						}
					} catch (error) {
						logger.error("[gateway] Failed to start a session in a new folder:", error);
						if (adapter) {
							await adapter.sendMessage(
								message.channelId,
								`Failed to start: ${error instanceof Error ? error.message : String(error)}`,
							);
						}
					}
					return;
				}
				if (sessionCommand.name === "detach" || sessionCommand.name === "new") {
					try {
						if (sessionCommand.name === "new") deleteSession(session.id);
						const isolated = getOrCreateSession(message.platform, message.channelId, message.userId, config.sessions);
						const file = ensureGatewaySessionFile(isolated);
						await switchRpcSession(file);
						clearChannelBinding(message.platform, message.channelId);
						state.sessions.set(`${message.platform}:${message.channelId}`, isolated);
						await adapter?.sendMessage(message.channelId, buildNewSessionMessage({ sessionFile: file }));
					} catch (error) {
						logger.error("[gateway] Failed to open isolated session:", error);
						await adapter?.sendMessage(message.channelId, "❌ 切换会话失败，请稍后重试。");
					}
					return;
				}
				if (!isAdmin(message.platform as Platform, message.userId)) {
					if (adapter) {
						await adapter.sendMessage(
							message.channelId,
							"Only admins can attach this chat to the desktop Pi session.",
						);
					}
					return;
				}
				const active = readActiveSession();
				if (!active) {
					if (adapter) {
						await adapter.sendMessage(
							message.channelId,
							"No desktop session found. Open Pi on the machine first so the gateway can publish it.",
						);
					}
					return;
				}
				try {
					await switchRpcSession(active.sessionFile);
					setChannelBinding(message.platform, message.channelId, active.sessionFile);
					const age = sessionFileAgeMs(active.sessionFile);
					if (adapter) {
						await adapter.sendMessage(
							message.channelId,
							buildContinueMessage({
								active,
								hot: age !== null && age < 15_000,
							}),
						);
					}
				} catch (error) {
					logger.error("[gateway] Failed to continue session:", error);
					if (adapter) {
						await adapter.sendMessage(
							message.channelId,
							`Failed to attach: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
				}
				return;
			}

			const boundSession = getChannelBinding(message.platform, message.channelId);
			if (boundSession && rpcProcess) {
				try {
					await switchRpcSession(boundSession.sessionFile);
				} catch (error) {
					logger.error("[gateway] Bound session switch failed:", error);
					const adapter = state.adapters.get(message.platform);
					if (adapter) {
						await adapter.sendMessage(
							message.channelId,
							`Could not reopen the attached session: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
					return;
				}
			}

			// ── Admin/allowed model commands ──
			const modelMatch = sessionCmd.match(/^\/model(?:\s+(.+))?$/i);
			const modelCallback = message.content.match(/^Callback:\s*model:(.+)/i);

			if (
				(modelMatch || modelCallback) &&
				isUserAllowed(message.platform as Platform, message.userId)
			) {
				const adapter = state.adapters.get(message.platform);
				if (!rpcProcess) {
					if (adapter) {
						await adapter.sendMessage(message.channelId, "Agent not running.");
					}
					return;
				}

				// Handle callback from inline keyboard
				if (modelCallback) {
					const key = modelCallback[1].trim();
					const parsed = parseModelKey(key);
					if (!parsed) return;
					const { provider, modelId } = parsed;

					// Only admins can actually switch models
					if (!isAdmin(message.platform as Platform, message.userId)) {
						if (adapter) {
							await adapter.sendMessage(
								message.channelId,
								"Only admins can switch models.",
							);
						}
						return;
					}

					try {
						const result = (await sendRpc("set_model", {
							provider,
							modelId,
						})) as {
							success: boolean;
							error?: string;
							data?: { name: string };
						};
						if (result.success) {
							const name = result.data?.name || `${provider}/${modelId}`;
							if (adapter) {
								await adapter.sendMessage(
									message.channelId,
									`✅ Model changed to ${name}`,
								);
							}
							logger.info(
								`[gateway] Admin ${message.userId} switched model to ${provider}/${modelId}`,
							);
						} else {
							if (adapter) {
								await adapter.sendMessage(
									message.channelId,
									`❌ Failed: ${result.error || "unknown"}`,
								);
							}
						}
					} catch (err) {
						logger.error("[gateway] Model switch failed:", err);
					}
					return;
				}

				const arg = (modelMatch?.[1] || "").trim();
				const normalizedArg = arg.toLowerCase();

				// /model (no args) or /model list → show available models
				if (!arg || normalizedArg === "list") {
					try {
						const result = (await sendRpc("get_available_models")) as {
							success: boolean;
							data?: {
								models: Array<{
									provider: string;
									id: string;
									name: string;
								}>;
							};
						};
						if (result.success && result.data) {
							const models = result.data.models;

							// Try inline keyboard for Telegram
							const telegram = adapter as unknown as {
								sendButtons?: (
									ch: string,
									text: string,
									btns: Array<Array<{ text: string; data: string }>>,
								) => Promise<string>;
							};
							const discord = adapter as {
								platform: string;
								sendModelPicker?: (
									ch: string,
									ownerUserId: string,
									models: CatalogModel[],
								) => Promise<string>;
							};
							if (adapter && discord.platform === "discord" && discord.sendModelPicker) {
								await discord.sendModelPicker(
									message.channelId,
									message.userId,
									models,
								);
							} else if (
								adapter &&
								modelListUsesInlineButtons(adapter.platform) &&
								telegram.sendButtons
							) {
								const buttons = models.map((m) => [
									{
										text: `${m.name} (${m.provider})`,
										data: `model:${m.provider}/${m.id}`,
									},
								]);
								await telegram.sendButtons(
									message.channelId,
									"<b>Available models</b>\nTap to switch:",
									buttons,
								);
							} else if (adapter) {
								await adapter.sendMessage(
									message.channelId,
									formatModelListText(models),
								);
							}
						} else if (adapter) {
							await adapter.sendMessage(
								message.channelId,
								"Could not retrieve model list from the agent.",
							);
						}
					} catch (err) {
						logger.error("[gateway] Failed to list models:", err);
						if (adapter) {
							await adapter.sendMessage(
								message.channelId,
								"Failed to send the model list to Discord. Try /model again in a few seconds.",
							);
						}
					}
					return;
				}

				// /model provider/modelId — only admins can switch
				if (!isAdmin(message.platform as Platform, message.userId)) {
					if (adapter) {
						await adapter.sendMessage(
							message.channelId,
							"Only admins can switch models. Use `/model` to see available models.",
						);
					}
					return;
				}

				const parsed = parseModelKey(arg);
				if (!parsed) {
					if (adapter) {
						await adapter.sendMessage(
							message.channelId,
							"Usage: `/model provider/modelId`\n`/model` to see available models.",
						);
					}
					return;
				}
				const { provider, modelId } = parsed;

				try {
					const result = (await sendRpc("set_model", {
						provider,
						modelId,
					})) as { success: boolean; error?: string; data?: { name: string } };
					if (result.success) {
						const name = result.data?.name || `${provider}/${modelId}`;
						if (adapter) {
							await adapter.sendMessage(
								message.channelId,
								`✅ Model changed to ${name}`,
							);
						}
						logger.info(
							`[gateway] Admin ${message.userId} switched model to ${provider}/${modelId}`,
						);
					} else {
						if (adapter) {
							await adapter.sendMessage(
								message.channelId,
								`❌ Failed: ${result.error || "unknown"}`,
							);
						}
					}
				} catch (err) {
					logger.error("[gateway] Failed to change model:", err);
					if (adapter) {
						await adapter.sendMessage(
							message.channelId,
							"Failed to change model.",
						);
					}
				}
				return;
			}

			// ── Admin restart command ──
			if (/^\/restart$/i.test(message.content.trim())) {
				if (!isAdmin(message.platform as Platform, message.userId)) {
					await state.adapters.get(message.platform)?.sendMessage(message.channelId, "只有管理员可以重启网关。");
					return;
				} else if (IS_DAEMON) {
					// Restart listeners, adapters, and the RPC child in-process. Sending
					// SIGHUP to self terminates Node abruptly on Windows.
					const adapter = state.adapters.get(message.platform);
					if (adapter) {
						await adapter.sendMessage(
							message.channelId,
							"♻️ Restarting gateway runtime…",
						);
					}
					try {
						await restartDaemonRuntime();
						logger.info(`[gateway] Admin ${message.userId} restarted gateway runtime`);
					} catch (error) {
						logger.error("[gateway] Failed to restart gateway runtime:", error);
						const activeAdapter = state.adapters.get(message.platform);
						if (activeAdapter) {
							await activeAdapter.sendMessage(
								message.channelId,
								"❌ Gateway runtime restart failed. Check the daemon log.",
							);
						}
					}
					return;
				} else {
					const adapter = state.adapters.get(message.platform);
					if (adapter) {
						await adapter.sendMessage(
							message.channelId,
							"♻️ Restarting pi agent…",
						);
					}

					// Kill and restart the pi RPC process
					if (rpcProcess) {
						rpcProcess.kill();
						rpcProcess = null;
					}
					rejectPendingRpc(new Error("Agent restarted by admin"));
					rpcProcess = createRpcProcess();

					logger.info(`[gateway] Admin ${message.userId} restarted pi agent`);

					if (adapter) {
						await adapter.sendMessage(
							message.channelId,
							"✅ Pi agent restarted.",
						);
					}
					return;
				}
			}

			// One reply lifecycle owns all preview edits and the final delivery.
			const adapter = state.adapters.get(message.platform);
			if (!rpcProcess) {
				await adapter?.sendMessage(message.channelId, "❌ Pi 当前未运行，请联系管理员启动网关。");
				return;
			}
			const turn = reservedTurn;
			if (!turn) return;
			const reply = adapter ? new ChatReply(adapter, message) : undefined;
			turn.reply = reply;
			try {
				await reply?.start();
				setFlushHandler(() => reply?.waitForAnswer());
				setStreamRedirectHandler(() => reply?.resume());
				if (turn.stopping) { await reply?.finish("", "stopped"); return; }
				if (!boundSession) await switchRpcSession(ensureGatewaySessionFile(session));
				if (turn.stopping) { await reply?.finish("", "stopped"); return; }
				const guard = buildPolicyGuard(message.platform, message.userId);
				const prompt = [message.content, ...turn.queued].join("\n\n");
				turn.queued = [];
				turn.phase = "running";
				const text = await sendPromptRpc(`${guard}\n\n${prompt}`,
					(text) => reply?.stream(text), undefined, (event) => {
						if (event.type === "message_end" && event.message?.stopReason === "aborted") turn.stopping = true;
						reply?.event(event);
					});
				turn.phase = "delivering";
				await reply?.finish(text, turn.stopping ? "stopped" : "success");
			} catch (error) {
				turn.phase = "delivering";
				logger.error("[gateway] Chat turn failed:", error);
				const detail = error instanceof Error ? error.message : String(error);
				try { await reply?.finish(turn.stopping ? "" : detail, turn.stopping ? "stopped" : "error"); }
				catch (deliveryError) { logger.error("[gateway] Failed to deliver turn error:", deliveryError); }
			}
		} finally {
			if (reservedTurn && activeChatTurn === reservedTurn) {
				cleanupPendingUiRequests();
				setFlushHandler(null);
				setStreamRedirectHandler(null);
				setActiveChannel(null);
				activeChatTurn = null;
				if (reservedTurn.deferred.length) {
					if (reservedTurn.stopping) {
						await adapterForCommand?.sendMessage(message.channelId, "🛑 已取消排队的补充，未启动后续任务。");
					} else {
						const first = reservedTurn.deferred[0];
						await adapterCallbacks.onMessage({ ...first, content: reservedTurn.deferred.map((item) => item.content).join("\n\n") });
					}
				}
			}
		}
	},
	onInteractiveResponse: (response: InteractiveResponse, fromUserId?: string) => {
		return handleInteractiveResponse(response, fromUserId);
	},
	onDisconnect: () => {
		logger.info("[gateway] Platform adapter disconnected");
		void updateStatus();
	},
};

// Initialize platform adapters
async function initializeAdapters(): Promise<void> {
	// Discord
	if (config.platforms.discord?.enabled && config.platforms.discord.botToken) {
		try {
			const discord = new DiscordAdapter({
				enabled: true,
				platform: "discord",
				botToken: config.platforms.discord.botToken,
				guildId: config.platforms.discord.guildId,
				allowedChannels: config.platforms.discord.allowedChannels,
				allowedRoles: config.platforms.discord.allowedRoles,
				requireMention: config.platforms.discord.requireMention,
				reactions: config.platforms.discord.reactions,
			});
			await discord.initialize();
			await discord.start(adapterCallbacks);
			state.adapters.set("discord", discord);
			logger.info("[gateway] Discord adapter started");
		} catch (err) {
			logger.error("[gateway] Failed to start Discord adapter:", err);
		}
	}

	// Twitch
	if (
		config.platforms.twitch?.enabled &&
		config.platforms.twitch.clientId &&
		config.platforms.twitch.clientSecret
	) {
		try {
			const twitch = new TwitchAdapter({
				enabled: true,
				platform: "twitch",
				clientId: config.platforms.twitch.clientId,
				clientSecret: config.platforms.twitch.clientSecret,
				channels: config.platforms.twitch.channels,
			});
			await twitch.initialize();
			await twitch.start(adapterCallbacks);
			state.adapters.set("twitch", twitch);
			logger.info("[gateway] Twitch adapter started");
		} catch (err) {
			logger.error("[gateway] Failed to start Twitch adapter:", err);
		}
	}

	// Telegram
	if (config.platforms.telegram?.enabled && config.platforms.telegram.token) {
		try {
			const telegram = new TelegramAdapter({
				enabled: true,
				platform: "telegram",
				token: config.platforms.telegram.token,
				webhookUrl: config.platforms.telegram.webhookUrl,
			});
			await telegram.initialize();
			await telegram.start(adapterCallbacks);
			state.adapters.set("telegram", telegram);
			logger.info("[gateway] Telegram adapter started");
		} catch (err) {
			logger.error("[gateway] Failed to start Telegram adapter:", err);
		}
	}

	// Slack
	if (
		config.platforms.slack?.enabled &&
		(config.platforms.slack.webhookUrl || config.platforms.slack.botToken)
	) {
		try {
			const slack = new SlackAdapter({
				enabled: true,
				platform: "slack",
				webhookUrl: config.platforms.slack.webhookUrl,
				botToken: config.platforms.slack.botToken,
			});
			await slack.initialize();
			await slack.start(adapterCallbacks);
			state.adapters.set("slack", slack);
			logger.info("[gateway] Slack adapter started");
		} catch (err) {
			logger.error("[gateway] Failed to start Slack adapter:", err);
		}
	}

	// WhatsApp
	if (config.platforms.whatsapp?.enabled) {
		try {
			const whatsapp = new WhatsAppAdapter({
				enabled: true,
				platform: "whatsapp",
				sessionPath: config.platforms.whatsapp.sessionPath,
				printQr: config.platforms.whatsapp.printQr,
			});
			await whatsapp.initialize();
			await whatsapp.start(adapterCallbacks);
			state.adapters.set("whatsapp", whatsapp);
			logger.info("[gateway] WhatsApp adapter started");
		} catch (err) {
			logger.error("[gateway] Failed to start WhatsApp adapter:", err);
		}
	}
}

// Cron job for background tasks and session cleanup
function startCron(): void {
	cronInterval = setInterval(async () => {
		// Check for pending background results
		for (const session of state.sessions.values()) {
			const pending = getPendingResultsForSession(session.id);
			for (const task of pending) {
				// Deliver result to user via their platform
				const adapter = state.adapters.get(session.platform);
				if (adapter) {
					const resultText =
						task.status === "completed"
							? `✅ Background task completed:\n\`\`\`\n${JSON.stringify(task.result, null, 2)}\n\`\`\``
							: `❌ Background task failed:\n\`\`\`\n${task.error}\n\`\`\``;

					await adapter.sendMessage(session.channelId, resultText);
					markTaskDelivered(task.id);
				}
			}
		}

		// Touch active sessions
		for (const session of state.sessions.values()) {
			touchSession(session.id);
		}
	}, 60000); // Every 60 seconds (Hermes-style)
}

function stopCron(): void {
	if (cronInterval) {
		clearInterval(cronInterval);
		cronInterval = null;
	}
}

// HTTP handlers
async function handleHttpRequest(
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	const corsOrigin =
		config.corsOrigins.length > 0 ? config.corsOrigins.join(",") : "";
	if (corsOrigin) {
		res.setHeader("Access-Control-Allow-Origin", corsOrigin);
	}
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

	if (req.method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}

	// ── Telegram webhook (unauthenticated — called by Telegram) ──
	const url = new URL(req.url || "/", `http://${req.headers.host}`);
	if (url.pathname === "/webhook/telegram" && req.method === "POST") {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", async () => {
			try {
				const body = JSON.parse(Buffer.concat(chunks).toString());
				const telegram = state.adapters.get("telegram") as any;
				if (telegram?.handleWebhookUpdate) {
					const secretHeader = req.headers["x-telegram-bot-api-secret-token"];
					await telegram.handleWebhookUpdate(
						body,
						typeof secretHeader === "string" ? secretHeader : undefined,
					);
					res.writeHead(200);
					res.end("ok");
				} else {
					res.writeHead(503);
					res.end("Telegram adapter not running");
				}
			} catch (error) {
				if (error instanceof Error && error.message.includes("webhook secret")) {
					res.writeHead(401);
					res.end("Unauthorized");
					return;
				}
				res.writeHead(400);
				res.end("Invalid request");
			}
		});
		return;
	}

	if (!authenticate(req)) {
		res.writeHead(401);
		res.end(JSON.stringify({ error: "Unauthorized" }));
		return;
	}

	// API endpoints
	if (url.pathname === "/api/status" && req.method === "GET") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({
				running: state.running,
				mode: IS_DAEMON ? "daemon" : "inline",
				pid: process.pid,
				adapters: Array.from(state.adapters.keys()),
				clients: state.clients.size,
				sessions: state.sessions.size,
				agent: rpcProcess !== null,
			}),
		);
		return;
	}

	if (url.pathname === "/api/sessions" && req.method === "GET") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(listSessions()));
		return;
	}

	if (url.pathname === "/api/background" && req.method === "GET") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(listTasks()));
		return;
	}

	if (url.pathname === "/api/allowlist" && req.method === "GET") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(listAllowlistedUsers()));
		return;
	}

	if (url.pathname === "/api/pairing" && req.method === "GET") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(listPendingPairingCodes()));
		return;
	}

	res.writeHead(404);
	res.end(JSON.stringify({ error: "Not found" }));
}

// WebSocket handler
function handleWebSocket(ws: WebSocket, req: IncomingMessage): void {
	if (!authenticate(req)) {
		ws.close(1008, "Unauthorized");
		return;
	}

	const clientId = randomBytes(8).toString("hex");
	state.clients.set(clientId, ws);

	logger.info(`[gateway] WebSocket client connected: ${clientId}`);

	sendWs(ws, { type: "connected", data: { clientId } });

	ws.on("message", async (data) => {
		try {
			const msg = JSON.parse(data.toString());

			switch (msg.type) {
				case "prompt": {
						if (activeChatTurn || isAgentBusy()) throw new Error("The agent is busy with another task");
						rpcTurnActive = true;
						try {
					const result = await sendRpc("prompt", {
						message: msg.data?.message || "",
					});
					sendWs(ws, { type: "response", id: msg.id, data: result });
						if (!(result as any).success) rpcTurnActive = false;
						} catch (error) { rpcTurnActive = false; throw error; }
					break;
				}
				case "background": {
					const task = startBackgroundTask(
						msg.data?.sessionId || "default",
						msg.data?.command || "",
					);
					sendWs(ws, { type: "background_started", data: task });
					break;
				}
				case "ping": {
					sendWs(ws, { type: "pong", data: { time: Date.now() } });
					break;
				}
			}
		} catch (err) {
			sendWs(ws, { type: "error", data: { error: String(err) } });
		}
	});

	ws.on("close", () => {
		state.clients.delete(clientId);
		logger.info(`[gateway] WebSocket client disconnected: ${clientId}`);
	});
}

// Status update
async function updateStatus(): Promise<void> {
	const ctx = globalCtx;
	if (!ctx) return;

	const generation = ++statusUpdateGeneration;
	const daemonPid = state.running ? null : readDaemonPid();
	const statusText = await resolveGatewayStatus({
		inlineRunning: state.running,
		adapterCount: state.adapters.size,
		daemonProcessRunning: daemonPid !== null,
		getDaemonHealth: () =>
			daemonPid === null ? Promise.resolve(null) : getDetachedGatewayHealth(daemonPid),
	});

	if (
		ctx !== globalCtx ||
		generation !== statusUpdateGeneration ||
		statusText === lastGatewayStatusText
	) {
		return;
	}
	lastGatewayStatusText = statusText;
	try {
		ctx.ui.setStatus("gateway", statusText);
	} catch (error) {
		if (!isStaleExtensionCtx(error)) throw error;
		if (statusRefreshInterval) {
			clearInterval(statusRefreshInterval);
			statusRefreshInterval = null;
		}
		globalCtx = null;
	}
}

function isStaleExtensionCtx(error: unknown): boolean {
	return error instanceof Error && /stale after session replacement/i.test(error.message);
}

function runOnLiveUi(fn: () => void): void {
	try {
		fn();
	} catch (error) {
		if (!isStaleExtensionCtx(error)) throw error;
	}
}

function readDetachedHealthConfig(): GatewayConfig {
	try {
		const parsed = JSON.parse(readFileSync(GATEWAY_CONFIG_FILE, "utf-8"));
		const healthConfig = normalizeGatewayHealthConfig(parsed);
		if (!healthConfig) throw new Error("Invalid detached health configuration");
		lastDetachedHealthConfig = {
			...lastDetachedHealthConfig,
			...healthConfig,
		} as GatewayConfig;
	} catch {
		// Keep the last valid probe target during a partial or invalid config write.
	}
	return lastDetachedHealthConfig ?? config;
}

async function getDetachedGatewayHealth(pid: number) {
	return fetchGatewayHealth(readDetachedHealthConfig(), pid);
}

export default function (pi: ExtensionAPI) {
	if (isGatewayRpcChild()) return;
	config = loadConfig();
	lastDetachedHealthConfig = config;
	state = {
		running: false,
		adapters: new Map(),
		clients: new Map(),
		sessions: new Map(),
	};

	// Initialize stores
	initSessionStore();
	initSecurityStore();
	initBackgroundTasks();

	// Register commands
	pi.registerCommand("gateway", {
		description: "Manage Hermes-style messaging gateway",
		getArgumentCompletions: (prefix: string) => {
			const cmds = [
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
			];
			return cmds
				.filter((c) => c.startsWith(prefix))
				.map((c) => ({ value: c, label: c }));
		},
		handler: async (args, ctx) => {
			const parts = args.split(/\s+/).filter(Boolean);
			const subcmd = parts[0]?.toLowerCase();

			switch (subcmd) {
				case "start": {
					const isDetached =
						parts.includes("-d") || parts.includes("--detached");

					if (isDetached) {
						const existingPid = readDaemonPid();
						if (existingPid !== null) {
							const existingHealth = await waitForGatewayHealth(
								readDetachedHealthConfig(),
								existingPid,
								1500,
							);
							if (existingHealth) {
								ctx.ui.notify(
									`Gateway daemon is already ${existingHealth.running ? "running" : "initializing"}.`,
									"info",
								);
								return;
							}
							ctx.ui.notify(
								`A live process owns the gateway PID file (PID ${existingPid}), but its daemon API is unavailable. Refusing to start another daemon.`,
								"error",
							);
							return;
						}

						// Spawn detached daemon from compiled JS or TypeScript source.
						const daemon = resolveDaemonInvocation(import.meta.url);
						const workspace = ensureDetachedWorkspace();
						const child = spawn(daemon.command, daemon.args, {
							detached: true,
							stdio: "ignore",
							cwd: workspace,
							env: process.env,
						});
						child.unref();
						if (child.pid === undefined) {
							ctx.ui.notify("Failed to spawn gateway daemon", "error");
							return;
						}

						const startedHealth = await waitForSpawnedDaemonHealth(
							readDetachedHealthConfig(),
							child.pid,
							readDaemonPid,
							15000,
						);
						if (!startedHealth) {
							ctx.ui.notify(
								`Gateway daemon spawn could not be verified (PID ${child.pid}). Check the gateway log.`,
								"error",
							);
							return;
						}

						ctx.ui.notify(
							`🔌 Gateway daemon ${startedHealth.running ? "started" : "is initializing"} (PID ${child.pid}).\n\n` +
								`Working directory: ${workspace}\n` +
								"It will keep running after pi closes.\n" +
								"Use /gateway status to check, /gateway stop to kill.",
							"info",
						);
						return;
					}

					if (state.running) {
						ctx.ui.notify("Gateway already running", "info");
						return;
					}

					// Reload config fresh on every start so users can edit
					// ~/.pi/gateway/config.json without restarting pi
					config = loadConfig();
					const port = parseInt(parts[1]) || config.port;

					await startGatewayServer(port);

					ctx.ui.notify(
						`✅ Gateway started on http://${config.host}:${port}\n\n` +
							`Working directory: ${process.cwd()}\n` +
							`Platforms: ${state.adapters.size > 0 ? Array.from(state.adapters.keys()).join(", ") : "none"}\n` +
							`Sessions: Idle reset every ${config.sessions.idleMinutes} min`,
						"info",
					);
					return;
				}

				case "stop": {
					// Never signal a PID until the daemon API confirms the same identity.
					const daemonPid = readDaemonPid();
					if (daemonPid !== null) {
						const health = await waitForGatewayHealth(
							readDetachedHealthConfig(),
							daemonPid,
							1500,
						);
						if (!health) {
							ctx.ui.notify(
								"Refusing to signal an unverified daemon PID. Check /gateway status.",
								"error",
							);
							return;
						}
						try {
							process.kill(daemonPid, "SIGTERM");
						} catch {
							ctx.ui.notify("Failed to stop daemon", "error");
							return;
						}

						for (let attempt = 0; attempt < 40; attempt++) {
							await new Promise((resolve) => setTimeout(resolve, 250));
							if (readDaemonPid() !== daemonPid) {
								ctx.ui.notify("Gateway daemon stopped", "info");
								return;
							}
						}
						ctx.ui.notify(
							`Stop signal sent, but daemon PID ${daemonPid} is still present.`,
							"warning",
						);
						return;
					}

					if (!state.running) {
						ctx.ui.notify("Gateway not running", "info");
						return;
					}

					await stopGatewayServer();
					ctx.ui.notify("Gateway stopped", "info");
					return;
				}

				case "restart": {
					if (state.running) {
						await stopGatewayServer();
					}

					// Reload config and start
					config = loadConfig();
					const port = parseInt(parts[1]) || config.port;
					await startGatewayServer(port);

					ctx.ui.notify(
						`✅ Gateway restarted on http://${config.host}:${port}\n\n` +
							`Platforms: ${state.adapters.size > 0 ? Array.from(state.adapters.keys()).join(", ") : "none"}\n` +
							`Sessions: Idle reset every ${config.sessions.idleMinutes} min`,
						"info",
					);
					return;
				}

				case "status": {
					const lines: string[] = [];
					const daemonPid = state.running ? null : readDaemonPid();
					const daemonHealth =
						daemonPid === null ? null : await getDetachedGatewayHealth(daemonPid);
					const report = createGatewayStatusReport({
						inlineRunning: state.running,
						inlineAdapters: state.adapters.size,
						inlineClients: state.clients.size,
						inlineSessions: state.sessions.size,
						inlineAgentConnected: Boolean(rpcProcess),
						daemonProcessRunning: daemonPid !== null,
						daemonHealth,
					});
					const displayConfig =
						daemonPid === null ? config : readDetachedHealthConfig();
					const metric = (value: number | null) => value ?? "unknown";

					if (daemonPid !== null) {
						lines.push(
							daemonHealth?.running
								? `Daemon: 🟢 Verified (PID ${daemonPid})`
								: daemonHealth
									? `Daemon: 🟡 Initializing (PID ${daemonPid})`
									: `Daemon: 🟡 Unavailable (PID ${daemonPid})`,
						);
						lines.push("");
					}

					lines.push(`Mode: ${report.mode}`);
					lines.push(`Port: ${displayConfig.port}`);
					lines.push(`Adapters: ${metric(report.adapters)}`);
					lines.push(`Clients: ${metric(report.clients)}`);
					lines.push(`Sessions: ${metric(report.sessions)}`);
					lines.push(
						`Agent: ${report.agentConnected === null ? "Unknown" : report.agentConnected ? "✅ Connected" : "❌ Disconnected"}`,
					);
					lines.push("");
					lines.push(`Session Reset: ${displayConfig.sessions.resetPolicy}`);
					lines.push(`  - Daily at ${displayConfig.sessions.dailyHour}:00`);
					lines.push(`  - Idle after ${displayConfig.sessions.idleMinutes} min`);
					lines.push("");
					const adminCount =
						listAdmins().length +
						Object.values(displayConfig.security.adminUids ?? {}).reduce(
							(sum, uids) => sum + uids.length,
							0,
						);
					lines.push(
						`Security: ${displayConfig.security.allowAll ? "Allow all" : "Allowlist only"}${Object.values(displayConfig.security.allowedUids ?? {}).reduce((sum, uids) => sum + uids.length, 0) > 0 ? ` (+${Object.values(displayConfig.security.allowedUids ?? {}).reduce((sum, uids) => sum + uids.length, 0)} config UIDs)` : ""}`,
					);
					lines.push(`Admins: ${adminCount}`);

					ctx.ui.setWidget("gateway-status", lines, {
						placement: "belowEditor",
					});
					setTimeout(() => {
						runOnLiveUi(() => ctx.ui.setWidget("gateway-status", undefined));
					}, 15000);
					return;
				}

				case "pair": {
					const code = parts[1]?.toUpperCase();
					const pending = code ? null : listPendingPairingCodes();
					if (pending) {
						ctx.ui.notify(
							"Pending pairing codes:\n" +
								(pending.length > 0
									? pending
											.map(
												(p) =>
													`${p.code} - ${p.platform} (${Math.round(p.expiresIn / 60000)}min)`,
											)
											.join("\n")
									: "None"),
							"info",
						);
						return;
					}

					if (approvePairingCode(code)) {
						ctx.ui.notify("Pairing code approved", "info");
					} else {
						ctx.ui.notify(`❌ Invalid or expired pairing code`, "error");
					}
					return;
				}

				case "allow": {
					const platform = parts[1] as Platform;
					const userId = parts[2];
					const list = listAllowlistedUsers();
					const configUids = config.security.allowedUids ?? {};
					const configLines: string[] = [];
					for (const [plat, uids] of Object.entries(configUids)) {
						for (const uid of uids) {
							configLines.push(`${plat}:${uid} (config)`);
						}
					}
					if (!platform || !userId) {
						ctx.ui.notify(
							"Allowlisted users:\n" +
								(list.length > 0 || configLines.length > 0
									? [
											...list.map((u) => `${u.platform}:${u.userId}`),
											...configLines,
										].join("\n")
									: "None"),
							"info",
						);
						return;
					}

					addToAllowlist(platform, userId);
					ctx.ui.notify(`Added ${userId} to allowlist`, "info");
					return;
				}

				case "revoke": {
					const platform = parts[1] as Platform;
					const userId = parts[2];
					if (!platform || !userId) {
						ctx.ui.notify(
							"Usage: /gateway revoke <platform> <userId>\n" +
								"Removes a user from the DB allowlist.",
							"info",
						);
						return;
					}

					const removed = revokeUserAccess(platform, userId);
					ctx.ui.notify(
						removed
							? `Removed ${userId} from allowlist`
							: `${userId} was not in the allowlist`,
						removed ? "info" : "error",
					);
					return;
				}

				case "admin": {
					const action = parts[1]?.toLowerCase();

					switch (action) {
						case "list": {
							const dbAdmins = listAdmins();
							const configAdmins = config.security.adminUids ?? {};
							const configLines: string[] = [];
							for (const [plat, uids] of Object.entries(configAdmins)) {
								for (const uid of uids) {
									configLines.push(`${plat}:${uid} (config)`);
								}
							}
							const dbLines = dbAdmins.map((a) => `${a.platform}:${a.userId}`);
							ctx.ui.notify(
								"Admin users:\n" +
									([...dbLines, ...configLines].length > 0
										? [...dbLines, ...configLines].join("\n")
										: "None"),
								"info",
							);
							return;
						}

						case "add": {
							const plat = parts[2];
							const uid = parts[3];
							if (!plat || !uid) {
								ctx.ui.notify(
									"Usage: /gateway admin add <platform|*> <userId>\n" +
										"Use * for platform to make admin on all platforms.\n" +
										"Admins bypass all tool restrictions and have full access.",
									"info",
								);
								return;
							}
							addAdmin(plat as Platform | "*", uid);
							ctx.ui.notify(
								`✅ ${uid} is now admin on ${plat === "*" ? "all platforms" : plat}`,
								"info",
							);
							return;
						}

						case "remove": {
							const plat = parts[2];
							const uid = parts[3];
							if (!plat || !uid) {
								ctx.ui.notify(
									"Usage: /gateway admin remove <platform|*> <userId>",
									"info",
								);
								return;
							}
							if (removeAdmin(plat as Platform | "*", uid)) {
								ctx.ui.notify(`Removed admin: ${plat}:${uid}`, "info");
							} else {
								ctx.ui.notify(`${uid} was not an admin on ${plat}`, "error");
							}
							return;
						}

						default: {
							ctx.ui.notify(
								"/gateway admin commands:\n\n" +
									"  list                  - Show all admins (DB + config)\n" +
									"  add <platform|*> <uid>  - Grant admin privileges\n" +
									"  remove <platform|*> <uid> - Revoke admin privileges\n\n" +
									"Admins bypass all tool restrictions and have full access.\n" +
									"Use * as platform to grant admin on all platforms.\n" +
									"Config-file admins: set adminUids in gateway-security.json",
								"info",
							);
						}
					}
					return;
				}

				case "sessions": {
					const sessions = listSessions();
					ctx.ui.notify(
						"Active sessions:\n" +
							sessions
								.slice(0, 10)
								.map(
									(s) =>
										`${s.platform}:${s.channelId} (${s.id.slice(0, 8)}...)`,
								)
								.join("\n"),
						"info",
					);
					return;
				}

				case "tasks": {
					const tasks = listTasks();
					ctx.ui.notify(
						"Background tasks:\n" +
							tasks
								.slice(0, 10)
								.map(
									(t) =>
										`${t.id.slice(0, 12)}... - ${t.status} (${t.progress}%)`,
								)
								.join("\n"),
						"info",
					);
					return;
				}

				case "config": {
					const configUidCount2 = Object.values(
						config.security.allowedUids ?? {},
					).reduce((sum, uids) => sum + uids.length, 0);
					ctx.ui.notify(
						`Gateway Config:\n\n` +
							`Port: ${config.port}\n` +
							`Sessions: ${config.sessions.resetPolicy}\n` +
							`Security: ${config.security.allowAll ? "Allow all" : "Allowlist"}` +
							` (${configUidCount2} config UIDs)\n` +
							`Discord: ${config.platforms.discord?.enabled ? "Enabled" : "Disabled"}`,
						"info",
					);
					return;
				}

				case "tool-policy": {
					const action = parts[1]?.toLowerCase();

					switch (action) {
						case "list": {
							const platform = parts[2];
							const userId = parts[3];
							const policies = listToolPolicies(platform, userId);
							if (policies.length === 0) {
								ctx.ui.notify(
									"No explicit tool policies — only defaults active.\n" +
										"Use /gateway tool-policy defaults to see them.",
									"info",
								);
								return;
							}
							ctx.ui.notify(
								"Tool policies:\n" +
									policies
										.map(
											(p) =>
												`#${p.id} ${p.platform ?? "*"}:${p.userId ?? "*"} → ${p.toolName} [${p.action}]`,
										)
										.join("\n"),
								"info",
							);
							return;
						}

						case "defaults": {
							const summary = getEffectivePolicySummary("*", "*");
							ctx.ui.notify(
								"Default Tool Policy (all external users):\n\n" +
									`✅ ALLOWED:\n  ${summary.allowed.join("\n  ")}\n\n` +
									`🚫 DENIED:\n  ${summary.denied.join("\n  ")}\n\n` +
									"Use /gateway tool-policy set to override.",
								"info",
							);
							return;
						}

						case "set": {
							const plat = parts[2] || null;
							const uid = parts[3] || null;
							const tool = parts[4];
							const act = parts[5]?.toLowerCase();

							if (!tool || (act !== "allow" && act !== "deny")) {
								ctx.ui.notify(
									"Usage: /gateway tool-policy set [platform] [userId] <toolName> allow|deny\n\n" +
										"Examples:\n" +
										"  /gateway tool-policy set discord * bash deny\n" +
										"  /gateway tool-policy set discord U123 bash allow\n" +
										"  /gateway tool-policy set * * write allow\n" +
										"  (Use * for platform/userId to mean all)",
									"info",
								);
								return;
							}

							setToolPolicy({
								platform: plat === "*" ? null : plat,
								userId: uid === "*" ? null : uid,
								toolName: tool,
								action: act as "allow" | "deny",
								priority: 50, // Explicit policies override default (priority 0)
							});

							ctx.ui.notify(
								`Policy set: ${plat ?? "*"}:${uid ?? "*"} → ${tool} [${act}]`,
								"info",
							);
							return;
						}

						case "remove": {
							const id = parseInt(parts[2]);
							if (isNaN(id)) {
								ctx.ui.notify(
									"Usage: /gateway tool-policy remove <id>\n" +
										"Use /gateway tool-policy list to see IDs.",
									"info",
								);
								return;
							}
							if (removeToolPolicy(id)) {
								ctx.ui.notify(`Removed tool policy #${id}`, "info");
							} else {
								ctx.ui.notify(`Policy #${id} not found`, "error");
							}
							return;
						}

						case "reset": {
							resetToolPolicies();
							ctx.ui.notify("All tool policies reset to defaults.", "info");
							return;
						}

						default: {
							ctx.ui.notify(
								"/gateway tool-policy commands:\n\n" +
									"  list [platform] [userId]  - List explicit policies\n" +
									"  defaults                   - Show default policy\n" +
									"  set <p> <u> <tool> allow|deny - Add/update policy\n" +
									"  remove <id>                - Delete a policy\n" +
									"  reset                      - Clear all, back to defaults\n\n" +
									"Use * for platform/userId to match all.\n" +
									"Tool names support globs: bash, gateway_*, wiki_*",
								"info",
							);
						}
					}
					return;
				}

				default: {
					ctx.ui.notify(
						"pi Gateway Commands:\n\n" +
							"  /gateway start [port]  - Start gateway\n" +
							"  /gateway stop         - Stop gateway\n" +
							"  /gateway restart      - Restart gateway\n" +
							"  /gateway status       - Show status\n" +
							"  /gateway pair <code>  - Approve pairing\n" +
							"  /gateway allow <p> <u>- Add user to allowlist\n" +
							"  /gateway revoke <p> <u>- Remove user from allowlist\n" +
							"  /gateway admin list   - List admin users\n" +
							"  /gateway admin add <p|*> <u> - Grant admin\n" +
							"  /gateway admin remove <p|*> <u> - Revoke admin\n" +
							"  /gateway sessions     - List sessions\n" +
							"  /gateway tasks        - List background tasks\n" +
							"  /gateway config       - Show config\n" +
							"  /gateway tool-policy  - Manage tool policies\n\n" +
							"Hermes-style features:\n" +
							"  - Per-chat sessions with reset policies\n" +
							"  - Platform adapters (Discord, etc.)\n" +
							"  - Background task support\n" +
							"  - Allowlist security (DB + config UIDs)\n" +
							"  - Tool policy (per-user tool allow/deny)",
						"info",
					);
				}
			}
		},
	});

	// Register tools
	pi.registerTool({
		name: "gateway_status",
		label: "Gateway Status",
		description: "Check Hermes-style gateway status",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			const daemonPid = state.running ? null : readDaemonPid();
			const daemonProcessRunning = daemonPid !== null;
			const daemonHealth =
				daemonPid === null ? null : await getDetachedGatewayHealth(daemonPid);
			const report = createGatewayStatusReport({
				inlineRunning: state.running,
				inlineAdapters: state.adapters.size,
				inlineClients: state.clients.size,
				inlineSessions: state.sessions.size,
				inlineAgentConnected: Boolean(rpcProcess),
				daemonProcessRunning,
				daemonHealth,
			});
			const metric = (value: number | null) => value ?? "unknown";
			const statusConfig =
				daemonPid === null ? config : readDetachedHealthConfig();
			const statusPid = daemonPid ?? (state.running ? process.pid : null);
			const agent =
				report.agentConnected === null
					? "Unknown"
					: report.agentConnected
						? "Connected"
						: "Disconnected";

			return {
				content: [
					{
						type: "text",
						text:
							`Gateway: ${report.status}\n` +
							`PID: ${statusPid ?? "unknown"}\n` +
							`Port: ${statusConfig.port}\n` +
							`Adapters: ${metric(report.adapters)}\n` +
							`Clients: ${metric(report.clients)}\n` +
							`Sessions: ${metric(report.sessions)}\n` +
							`Agent: ${agent}`,
					},
				],
				details: {
					running: report.running,
					mode: report.mode,
					pid: statusPid,
					port: statusConfig.port,
					adapters: report.adapters,
					clients: report.clients,
					sessions: report.sessions,
					agentConnected: report.agentConnected,
				},
			};
		},
	});

	pi.registerTool({
		name: "gateway_sessions",
		label: "Gateway Sessions",
		description: "List active gateway sessions",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			const sessions = listSessions();
			return {
				content: [
					{
						type: "text",
						text:
							`Active sessions: ${sessions.length}\n` +
							JSON.stringify(
								sessions.map((s) => ({
									id: s.id.slice(0, 12),
									platform: s.platform,
									channel: s.channelId,
									lastActivity: new Date(s.lastActivity).toISOString(),
								})),
								null,
								2,
							),
					},
				],
				details: { count: sessions.length },
			};
		},
	});

	pi.registerTool({
		name: "gateway_background_tasks",
		label: "Background Tasks",
		description: "List and manage background tasks",
		parameters: Type.Object({
			status: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const tasks = listTasks(params.status as any);
			return {
				content: [
					{
						type: "text",
						text:
							`Background tasks: ${tasks.length}\n` +
							JSON.stringify(
								tasks.map((t) => ({
									id: t.id.slice(0, 12),
									status: t.status,
									progress: t.progress,
									command: t.command.slice(0, 50),
								})),
								null,
								2,
							),
					},
				],
				details: { count: tasks.length },
			};
		},
	});

	pi.registerTool({
		name: "gateway_pairing",
		label: "Gateway Pairing",
		description: "Generate or approve pairing codes",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("generate"),
				Type.Literal("list"),
				Type.Literal("approve"),
			]),
			platform: Type.Optional(Type.String()),
			userId: Type.Optional(Type.String()),
			code: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { action, platform, userId, code } = params;
			switch (action) {
				case "generate": {
					if (!platform || !userId) {
						return {
							content: [{ type: "text", text: "platform and userId required" }],
							details: { error: true },
						};
					}
					const pairingCode = generatePairingCode(platform as Platform, userId);
					return {
						content: [
							{
								type: "text",
								text: `Pairing code: ${pairingCode}\n\nShare this code with the user to approve access.`,
							},
						],
						details: { code: pairingCode },
					};
				}
				case "approve": {
					if (!code) {
						return {
							content: [{ type: "text", text: "code required" }],
							details: { error: true },
						};
					}
					const success = approvePairingCode(code);
					return {
						content: [
							{
								type: "text",
								text: success ? "✅ Code approved" : "❌ Invalid/expired",
							},
						],
						details: { success },
					};
				}
				case "list": {
					const pending = listPendingPairingCodes();
					return {
						content: [
							{
								type: "text",
								text:
									`Pending codes: ${pending.length}\n` +
									JSON.stringify(pending, null, 2),
							},
						],
						details: { count: pending.length },
					};
				}
			}
		},
	});

	pi.registerTool({
		name: "gateway_tool_policy",
		label: "Gateway Tool Policy",
		description: "Manage tool access policies for external gateway users",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("list"),
				Type.Literal("defaults"),
				Type.Literal("set"),
				Type.Literal("remove"),
				Type.Literal("reset"),
			]),
			platform: Type.Optional(Type.String()),
			userId: Type.Optional(Type.String()),
			toolName: Type.Optional(Type.String()),
			policyAction: Type.Optional(
				Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
			),
			policyId: Type.Optional(Type.Number()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { action, platform, userId, toolName, policyAction, policyId } =
				params;

			switch (action) {
				case "list": {
					const policies = listToolPolicies(platform, userId);
					return {
						content: [
							{
								type: "text",
								text:
									policies.length > 0
										? JSON.stringify(policies, null, 2)
										: "No explicit policies — only defaults active.",
							},
						],
						details: { count: policies.length, policies },
					};
				}

				case "defaults": {
					const summary = getEffectivePolicySummary(
						platform ?? "*",
						userId ?? "*",
					);
					return {
						content: [
							{
								type: "text",
								text:
									`Default tool policy:\n\n` +
									`ALLOWED: ${summary.allowed.join(", ")}\n` +
									`DENIED: ${summary.denied.join(", ")}`,
							},
						],
						details: summary,
					};
				}

				case "set": {
					if (!toolName || !policyAction) {
						return {
							content: [
								{
									type: "text",
									text: "toolName and policyAction (allow|deny) are required",
								},
							],
							details: { error: true },
						};
					}
					setToolPolicy({
						platform: platform ?? null,
						userId: userId ?? null,
						toolName,
						action: policyAction,
						priority: 50,
					});
					return {
						content: [
							{
								type: "text",
								text: `Policy set: ${platform ?? "*"}:${userId ?? "*"} → ${toolName} [${policyAction}]`,
							},
						],
						details: { success: true },
					};
				}

				case "remove": {
					if (policyId == null) {
						return {
							content: [
								{ type: "text", text: "policyId (number) is required" },
							],
							details: { error: true },
						};
					}
					const removed = removeToolPolicy(policyId);
					return {
						content: [
							{
								type: "text",
								text: removed
									? `Removed policy #${policyId}`
									: `Policy #${policyId} not found`,
							},
						],
						details: { success: removed },
					};
				}

				case "reset": {
					resetToolPolicies();
					return {
						content: [
							{ type: "text", text: "All tool policies reset to defaults." },
						],
						details: { success: true },
					};
				}
			}
		},
	});

	// Keep the footer synchronized with detached daemons started outside this session.
	pi.on("session_start", async (_event, ctx) => {
		const sessionFile = ctx.sessionManager?.getSessionFile?.();
		if (sessionFile) {
			publishActiveSession({
				sessionFile,
				sessionId: ctx.sessionManager.getSessionId?.(),
				cwd: ctx.cwd ?? ctx.sessionManager.getCwd?.(),
			});
		}
		if (statusRefreshInterval) clearInterval(statusRefreshInterval);
		statusRefreshInterval = null;
		globalCtx = ctx;
		lastGatewayStatusText = null;
		await updateStatus();
		if (globalCtx !== ctx) return;

		statusRefreshInterval = setInterval(
			updateStatus,
			STATUS_REFRESH_INTERVAL_MS,
		);
		statusRefreshInterval.unref();
	});

	pi.on("session_shutdown", async () => {
		await stopGatewayServer();
		statusUpdateGeneration++;
		if (statusRefreshInterval) clearInterval(statusRefreshInterval);
		statusRefreshInterval = null;
		lastGatewayStatusText = null;
		globalCtx = null;
		closeBackgroundTasks();
		closeSecurityStore();
		closeSessionStore();
	});

	logger.info("[pi-gateway] Hermes-style gateway extension loaded");
}

// ═══════════════════════════════════════════════════════════
// Daemon mode — run gateway as a standalone detached process
// ═══════════════════════════════════════════════════════════

/** Apply config changes with listener rollback so the daemon stays manageable. */
async function reloadDaemonConfig(): Promise<void> {
	const previousConfig = config;
	const nextConfig = mergeGatewayConfig(
		JSON.parse(readFileSync(GATEWAY_CONFIG_FILE, "utf-8")),
	);
	const listenerChanged =
		nextConfig.host !== previousConfig.host ||
		nextConfig.port !== previousConfig.port;

	if (!listenerChanged || !state.running) {
		config = nextConfig;
		return;
	}

	await stopGatewayServer();
	config = nextConfig;
	try {
		await startGatewayServer(config.port);
	} catch (rebindError) {
		await stopGatewayServer();
		config = previousConfig;
		try {
			await startGatewayServer(config.port);
			writeFileSync(
				GATEWAY_CONFIG_FILE,
				`${JSON.stringify(previousConfig, null, 2)}\n`,
			);
		} catch (rollbackError) {
			logger.error(
				`[pi-gateway] Listener rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
			);
			process.kill(process.pid, "SIGTERM");
		}
		throw new Error(
			`Listener rebind failed and was rolled back: ${rebindError instanceof Error ? rebindError.message : String(rebindError)}`,
		);
	}
}

/** Restart daemon-owned resources without self-signalling (unsafe on Windows). */
function restartDaemonRuntime(): Promise<void> {
	const restart = async () => {
		const previousConfig = config;
		const nextConfig = loadConfig();
		await stopGatewayServer();
		config = nextConfig;
		try {
			await startGatewayServer(config.port);
		} catch (restartError) {
			await stopGatewayServer();
			config = previousConfig;
			try {
				await startGatewayServer(config.port);
			} catch (rollbackError) {
				logger.error(
					"[pi-gateway] Runtime restart rollback failed:",
					rollbackError,
				);
			}
			throw restartError;
		}
	};
	configReloadQueue = configReloadQueue.then(restart, restart);
	return configReloadQueue;
}

/** Watch ~/.pi/gateway/config.json for validated, serialized reloads. */
function startConfigWatcher(): void {
	if (!existsSync(GATEWAY_CONFIG_FILE)) return;

	watchFile(GATEWAY_CONFIG_FILE, () => {
		if (daemonShuttingDown) return;
		configReloadQueue = configReloadQueue
			.then(reloadDaemonConfig)
			.then(() => {
				logger.info("[pi-gateway] Config reloaded from", GATEWAY_CONFIG_FILE);
			})
			.catch((error) => {
				logger.error(
					"[pi-gateway] Config reload failed — keeping previous valid config. Error:",
					error instanceof Error ? error.message : String(error),
				);
			});
	});

	logger.info(
		"[pi-gateway] Watching config file for changes:",
		GATEWAY_CONFIG_FILE,
	);
}

const IS_DAEMON = process.argv.includes("--daemon");

if (IS_DAEMON) {
	detachAndRun();
}

async function detachAndRun(): Promise<void> {
	process.title = "pi-gateway-daemon";
	process.stdout.write = () => true;
	process.stderr.write = () => true;

	// Acquire the daemon identity atomically before opening any resources.
	try {
		writeGatewayPidFile(PID_FILE, process.pid);
	} catch (error) {
		logger.error(
			`[pi-gateway] Failed to acquire daemon PID file: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	}

	let shutdownStarted = false;
	const shutdown = async (exitCode = 0) => {
		if (shutdownStarted) return;
		shutdownStarted = true;
		daemonShuttingDown = true;
		unwatchFile(GATEWAY_CONFIG_FILE);
		logger.info("[pi-gateway] Daemon shutting down...");
		await configReloadQueue.catch(() => {});
		if (state?.running || server || rpcProcess) {
			await Promise.race([
				stopGatewayServer(),
				new Promise<void>((resolve) => setTimeout(resolve, 10000)),
			]);
		}
		removeGatewayPidFile(PID_FILE, process.pid);
		process.exit(exitCode);
	};
	process.on("SIGTERM", () => void shutdown());
	process.on("SIGINT", () => void shutdown());
	process.on("uncaughtException", (err) => {
		logger.error(
			`[pi-gateway] UNCAUGHT EXCEPTION: ${err.stack || err.message}`,
		);
		void shutdown(1);
	});
	process.on("unhandledRejection", (reason) => {
		logger.error(
			`[pi-gateway] UNHANDLED REJECTION: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`,
		);
	});

	logger.info(`[pi-gateway] Daemon starting (PID ${process.pid})`);
	try {
		const workspace = ensureDetachedWorkspace();
		process.chdir(workspace);
		logger.info(`[pi-gateway] Daemon working directory: ${workspace}`);
		config = loadConfig();
		state = {
			running: false,
			adapters: new Map(),
			clients: new Map(),
			sessions: new Map(),
		};
		initSessionStore();
		initSecurityStore();
		initBackgroundTasks();

		process.on("SIGHUP", () => {
			if (daemonShuttingDown) return;
			configReloadQueue = configReloadQueue
				.then(async () => {
					logger.info("[pi-gateway] SIGHUP received — reloading config...");
					await reloadDaemonConfig();
					logger.info("[pi-gateway] SIGHUP config reload complete");
				})
				.catch((error) => {
					logger.error(
						`[pi-gateway] SIGHUP reload failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				});
		});

		await startGatewayServer(config.port);
		startConfigWatcher();
		logger.info(`[pi-gateway] Daemon ready (PID ${process.pid})`);
	} catch (error) {
		logger.error(
			`[pi-gateway] Daemon startup failed: ${error instanceof Error ? error.stack || error.message : String(error)}`,
		);
		await shutdown(1);
	}
}

async function startGatewayServer(port: number): Promise<void> {
	if (state.running) {
		logger.info("[gateway] Server already running");
		return;
	}

	server = createServer(handleHttpRequest);

	await new Promise<void>((resolve, reject) => {
		server!.listen(port, config.host, () => {
			logger.info(`[gateway] HTTP server started on ${config.host}:${port}`);
			resolve();
		});
		server!.on("error", reject);
	});

	if (config.enableWebSocket) {
		wss = new WebSocketServer({ server });
		wss.on("connection", handleWebSocket);
	}

	rpcProcess = createRpcProcess();
	await initializeAdapters();
	startCron();
	state.running = true;
	await updateStatus();
}

async function stopGatewayServer(): Promise<void> {
	if (!state?.running && !server && !rpcProcess) return;
	state.running = false;

	if (activeChatTurn?.reply) {
		activeChatTurn.stopping = true;
		try { await activeChatTurn.reply.finish("网关正在关闭。", "stopped"); }
		catch (error) { logger.warn("[gateway] Could not close the active reply:", error); }
	}
	rejectPendingRpc(new Error("Gateway stopped"));
	cleanupPendingUiRequests();
	setActiveChannel(null);
	setFlushHandler(null);
	setStreamRedirectHandler(null);

	await Promise.allSettled(
		Array.from(state.adapters.values(), (adapter) => adapter.stop()),
	);
	state.adapters.clear();

	stopCron();

	for (const ws of state.clients.values()) {
		ws.close(1000, "Server shutting down");
	}
	state.clients.clear();

	const serverToClose = server;
	const webSocketServerToClose = wss;
	server = null;
	wss = null;
	try {
		webSocketServerToClose?.close();
	} catch {
		/* server was never listening */
	}
	if (serverToClose) {
		await new Promise<void>((resolve) => {
			serverToClose.close(() => resolve());
		});
	}

	if (rpcProcess) {
		const oldProcess = rpcProcess;
		rpcProcess = null;
		oldProcess.kill();
	}

	void updateStatus();
}
