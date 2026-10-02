/**
 * Discord Adapter - Hermes-style Discord platform adapter
 * 
 * Features:
 * - DM and guild channel support
 * - Slash command registration
 * - Typing indicators
 * - Message editing/deletion
 * - Rate limit handling
 */

import {
  BaseAdapter,
  type InteractivePrompt,
  type PlatformConfig,
  type PlatformMessage,
  type MessageEditOptions,
  type MessageDelivery,
  type InteractiveOutcome,
} from "./base.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { hasPendingInteractiveForUser, interactiveResponseStatus } from "../interactive.js";
import { logger } from "../logger.js";
import { DISCORD_SLASH_COMMANDS, slashInteractionToContent } from "./slash-commands.js";
import {
  buildDiscordInteractiveMessage,
  discordRetryAfterMs,
  parseDiscordButtonCustomId,
  splitDiscordContent,
  truncateDiscordContent,
  truncateDiscordLabel,
  buildDiscordInputModal,
} from "./discord-interactive.js";
import {
  buildDiscordHeartbeat,
  buildDiscordIdentify,
  buildDiscordResume,
  canResumeDiscordSession,
  discordReconnectDelayMs,
  isDiscordFatalClose,
} from "./discord-gateway.js";
import {
  buildDiscordModelPicker,
  DISCORD_MODEL_BACK_ID,
  DISCORD_MODEL_SELECT_ID,
  DISCORD_PROVIDER_SELECT_ID,
  forgetDiscordModelPicker,
  getDiscordModelPickerState,
  listDiscordProviders,
  parseDiscordModelPageCustomId,
  parseDiscordProviderPageCustomId,
  rememberDiscordModelPicker,
  resolveDiscordModelSelection,
  resolveDiscordProviderSelection,
  updateDiscordModelPickerView,
  type CatalogModel,
} from "../model-list.js";

export interface DiscordConfig extends PlatformConfig {
  platform: "discord";
  botToken: string;
  guildId?: string;
  allowedChannels?: string[];  // Whitelist specific channels
  allowedRoles?: string[];     // Whitelist roles
  requireMention?: boolean;    // Require @mention in guilds
  reactions?: boolean;
}

/** Drop bot/self messages so the bot cannot allowlist-loop on its own replies. */
export function shouldIgnoreDiscordAuthor(
  author: { id?: string; bot?: boolean } | null | undefined,
  botId?: string | null,
): boolean {
  if (!author?.id) return true;
  if (author.bot) return true;
  if (botId && author.id === botId) return true;
  return false;
}

export class DiscordAdapter extends BaseAdapter {
  readonly platform = "discord" as const;
  config: DiscordConfig;
  private httpClient: typeof fetch | null = null;
  private wsConnection: WebSocket | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private botUserId: string | null = null;
  private applicationId: string | null = null;
  private intents: number = 0;
  private heartbeatAcked = true;
  private heartbeatIntervalMs = 0;
  private heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private lastCloseCode: number | null = null;
  private slashContext = new AsyncLocalStorage<{ channelId: string; token: string; applicationId: string; responded: boolean }>();
  private interactiveMessages = new Map<string, { prompt: InteractivePrompt; content: string }>();
  private previews = new Map<string, string>();
  private overflowMessages = new Map<string, string[]>();
  private activeReplies = new Map<string, string>();
  private resumePickers = new Map<string, { owner: string; expiresAt: number }>();
  private static readonly MAX_SPLIT_MESSAGES = 8;

  constructor(config: DiscordConfig) {
    super();
    this.config = config;
    
    // Intents: GUILD_MESSAGES (1<<9) + DIRECT_MESSAGES (1<<12) + MESSAGE_CONTENT (1<<15)
    this.intents = 1 << 9 | 1 << 12 | 1 << 15;
  }

  async initialize(): Promise<void> {
    // Test bot token
    const response = await this.apiRequest("/users/@me");
    const data: any = await response.json();
    if (!response.ok) {
      throw new Error(`Discord authentication failed: ${response.status}`);
    }
    logger.info(`[Discord] Bot initialized: ${data.username}`);
  }

  private async apiRequest(endpoint: string, options: RequestInit = {}): Promise<Response> {
    const url = `https://discord.com/api/v10${endpoint}`;
    return fetch(url, {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(15_000),
      headers: {
        "Authorization": `Bot ${this.config.botToken}`,
        ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
        ...options.headers,
      },
    });
  }

  async start(callbacks): Promise<void> {
    await super.start(callbacks);
    await this.connectGateway();
  }

  private async connectGateway(): Promise<void> {
    if (!this.running) return;
    this.clearReconnectTimer();
    this.teardownSocket();

    const gatewayResponse = await this.apiRequest("/gateway");
    const gatewayData = (await gatewayResponse.json()) as { url: string };
    const gatewayUrl = `${gatewayData.url}?v=10&encoding=json&intents=${this.intents}`;

    this.wsConnection = new WebSocket(gatewayUrl);

    this.wsConnection.onopen = () => {
      logger.info("[Discord] WebSocket connected");
    };

    this.wsConnection.onmessage = async (event) => {
      try {
        const data: any = JSON.parse(event.data);
        await this.handleGatewayMessage(data);
      } catch (error) {
        logger.error("[Discord] Gateway event failed:", error);
      }
    };

    this.wsConnection.onerror = (err) => {
      logger.error("[Discord] WebSocket error:", err);
    };

    this.wsConnection.onclose = (event) => {
      logger.info(
        `[Discord] WebSocket closed code=${event.code} reason=${event.reason || ""}`,
      );
      this.callbacks?.onDisconnect?.();
      this.lastCloseCode = event.code;
      if (isDiscordFatalClose(event.code)) {
        logger.error("[Discord] Fatal gateway close — not reconnecting");
        this.teardownSocket();
        this.running = false;
        this.sessionId = null;
        this.sequence = null;
        return;
      }
      if (
        !canResumeDiscordSession({
          sessionId: this.sessionId,
          sequence: this.sequence,
          closeCode: event.code,
        })
      ) {
        this.sessionId = null;
        this.sequence = null;
      }
      this.scheduleReconnect(`ws close ${event.code}`);
    };
  }

  private async handleGatewayMessage(data: any): Promise<void> {
    switch (data.op) {
      case 0: // Dispatch
        this.sequence = data.s;
        await this.handleDispatch(data.t, data.d);
        break;

      case 1: // Heartbeat request
        this.sendHeartbeat(true);
        break;

      case 7: // Reconnect
        logger.info("[Discord] Opcode 7 reconnect requested");
        this.scheduleReconnect("opcode 7");
        break;

      case 9: { // Invalid Session
        const resumable = data.d === true;
        logger.warn(`[Discord] Invalid session resumable=${resumable}`);
        if (
          !canResumeDiscordSession({
            sessionId: this.sessionId,
            sequence: this.sequence,
            invalidSessionResumable: resumable,
          })
        ) {
          this.sessionId = null;
          this.sequence = null;
        }
        this.scheduleReconnect("invalid session");
        break;
      }

      case 10: // Hello
        this.startHeartbeat(data.d.heartbeat_interval);
        if (
          canResumeDiscordSession({
            sessionId: this.sessionId,
            sequence: this.sequence,
            closeCode: this.lastCloseCode,
          })
        ) {
          this.resume();
        } else {
          this.identify();
        }
        break;

      case 11: // Heartbeat ACK
        this.heartbeatAcked = true;
        break;
    }
  }

  private startHeartbeat(interval: number): void {
    this.clearHeartbeat();
    this.heartbeatIntervalMs = interval;
    this.heartbeatAcked = true;
    const delay = Math.max(0, interval * Math.random());
    this.heartbeatTimeout = setTimeout(() => {
      this.heartbeatTimeout = null;
      this.sendHeartbeat();
      this.scheduleHeartbeatInterval();
    }, delay);
  }

  private sendHeartbeat(force = false): void {
    if (!this.running) return;
    if (!force && !this.heartbeatAcked) {
      logger.warn("[Discord] Heartbeat ACK missing — reconnecting");
      this.scheduleReconnect("missing heartbeat ack");
      return;
    }
    if (this.wsConnection?.readyState !== WebSocket.OPEN) return;
    this.heartbeatAcked = false;
    this.wsConnection.send(JSON.stringify(buildDiscordHeartbeat(this.sequence)));
    if (force) {
      if (this.heartbeatTimeout) {
        clearTimeout(this.heartbeatTimeout);
        this.heartbeatTimeout = null;
      }
      this.scheduleHeartbeatInterval();
    }
  }

  private scheduleHeartbeatInterval(): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.heartbeatIntervalMs <= 0) {
      this.heartbeatInterval = null;
      return;
    }
    this.heartbeatInterval = setInterval(
      () => this.sendHeartbeat(),
      this.heartbeatIntervalMs,
    );
  }

  private identify(): void {
    this.wsConnection?.send(
      JSON.stringify(buildDiscordIdentify(this.config.botToken, this.intents)),
    );
  }

  private resume(): void {
    if (!this.sessionId) {
      this.identify();
      return;
    }
    logger.info("[Discord] Resuming gateway session");
    this.wsConnection?.send(
      JSON.stringify(
        buildDiscordResume(this.config.botToken, this.sessionId, this.sequence),
      ),
    );
  }

  private scheduleReconnect(reason: string): void {
    if (!this.running) return;
    if (this.reconnectTimer) return;
    this.teardownSocket();
    const delay = discordReconnectDelayMs(this.reconnectAttempt++);
    logger.info(
      `[Discord] Reconnecting in ${delay}ms (${reason}, attempt ${this.reconnectAttempt})`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectGateway().catch((err) => {
        logger.error("[Discord] Reconnect failed:", err);
        this.scheduleReconnect("connect failed");
      });
    }, delay);
  }

  private teardownSocket(): void {
    this.clearHeartbeat();
    const ws = this.wsConnection;
    this.wsConnection = null;
    if (!ws) return;
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
    ws.onopen = null;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      try {
        ws.close(1000, "adapter stop");
      } catch {
        /* already closing */
      }
    }
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.heartbeatIntervalMs = 0;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private async handleDispatch(type: string, data: any): Promise<void> {
    switch (type) {
      case "READY":
        this.sessionId = data.session_id;
        this.botUserId = data.user?.id ?? null;
        this.applicationId = data.application?.id ?? data.user?.id ?? null;
        this.reconnectAttempt = 0;
        this.lastCloseCode = null;
        logger.info(`[Discord] Logged in as ${data.user.username}`);
        await this.registerDefaultSlashCommands();
        break;

      case "RESUMED":
        this.reconnectAttempt = 0;
        this.lastCloseCode = null;
        logger.info("[Discord] Session resumed");
        break;

      case "MESSAGE_CREATE":
        await this.handleMessage(data);
        break;

      case "INTERACTION_CREATE":
        await this.handleInteraction(data);
        break;

      case "MESSAGE_UPDATE":
        // Handle edits if needed
        break;
    }
  }

  private async handleMessage(data: any): Promise<void> {
    if (shouldIgnoreDiscordAuthor(data.author, this.getBotId())) return;
    if (!this.isAllowedGuildContext(data)) return;

    const isDM = !data.guild_id;

    const rawContent = typeof data.content === "string" ? data.content : "";
    const botId = this.getBotId();
    const escapedBotId = botId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const mention = new RegExp(`<@!?${escapedBotId}>`, "g");
    const mentioned = mention.test(rawContent);
    mention.lastIndex = 0;
    const replyingToBot = data.referenced_message?.author?.id === botId;
    // Replies to the bot are also a direct conversation, including permission answers.
    if (!isDM && this.config.requireMention) {
      if (!mentioned && !replyingToBot && !hasPendingInteractiveForUser(this.platform, data.channel_id, data.author.id)) return;
    }
    let content = rawContent.replace(mention, "");
    if (rawContent.startsWith(`<@${botId}>`) || rawContent.startsWith(`<@!${botId}>`)) content = content.replace(/^[ \t]/, "");
    if (!content.trim()) return;

    const message: PlatformMessage = {
      id: data.id,
      platform: this.platform,
      channelId: data.channel_id,
      userId: data.author.id,
      content,
      timestamp: new Date(data.timestamp).getTime(),
      metadata: {
        guildId: data.guild_id,
        username: data.author.username,
        discriminator: data.author.discriminator,
        isDM,
        replyToMessageId: data.message_reference?.message_id,
      },
    };

    await this.emitMessage(message);
  }

  private getBotId(): string {
    if (this.botUserId) return this.botUserId;
    try {
      return Buffer.from(this.config.botToken.split(".")[0], "base64").toString("utf8");
    } catch {
      return this.config.botToken.split(".")[0];
    }
  }

  private async handleInteraction(data: any): Promise<void> {
    if (!this.isAllowedGuildContext(data)) {
      await this.ackInteraction(data, { type: 4, data: { content: "此频道或身份组未开放网关访问。", flags: 64 } });
      return;
    }
    if (data.type === 5) {
      await this.handleModalInteraction(data);
      return;
    }
    // 3 = MESSAGE_COMPONENT (button / select menu)
    if (data.type === 3) {
      await this.handleComponentInteraction(data);
      return;
    }
    // 2 = APPLICATION_COMMAND (slash)
    if (data.type !== 2) return;
    const content = slashInteractionToContent(data.data ?? {});
    if (!content) return;

    const userId = data.member?.user?.id ?? data.user?.id;
    const channelId = data.channel_id;
    if (!userId || !channelId) return;

    try {
      await this.ackInteraction(data, { type: 5 });
    } catch (error) {
      logger.error("[Discord] Failed to acknowledge slash command:", error);
      return;
    }

    const message: PlatformMessage = {
      id: data.id,
      platform: this.platform,
      channelId,
      userId,
      content,
      timestamp: Date.now(),
      metadata: {
        guildId: data.guild_id,
        username: data.member?.user?.username ?? data.user?.username,
        isDM: !data.guild_id,
        slashCommand: true,
      },
    };
    const context = { channelId, token: data.token, applicationId: data.application_id ?? this.applicationId ?? this.getBotId(), responded: false };
    await this.slashContext.run(context, async () => {
      try {
        await this.callbacks?.onMessage(message);
        if (!context.responded) await this.sendDiscordMessage(channelId, { content: "✅ 指令已处理。" });
      } catch (error) {
        logger.error("[Discord] Slash command failed:", error);
        if (!context.responded) await this.sendDiscordMessage(channelId, { content: "❌ 指令执行失败，请稍后重试。" });
      }
    });
  }

  private isAllowedGuildContext(data: any): boolean {
    if (!data.guild_id) return true;
    if (this.config.allowedChannels?.length && !this.config.allowedChannels.includes(data.channel_id)) return false;
    if (this.config.allowedRoles?.length && !this.config.allowedRoles.some((role) => data.member?.roles?.includes(role))) return false;
    return true;
  }

  private async ackInteraction(
    data: any,
    payload: { type: number; data?: Record<string, unknown> },
  ): Promise<void> {
    await this.requestDiscordWithRetry(`/interactions/${data.id}/${data.token}/callback`, {
        method: "POST",
        body: JSON.stringify({ ...payload, ...([4, 7].includes(payload.type) && payload.data ? { data: { ...payload.data, allowed_mentions: { parse: [], replied_user: false } } } : {}) }),
      }, "acknowledge interaction");
  }

  private async handleModelPickerInteraction(data: any): Promise<boolean> {
    const customId: string = data.data?.custom_id ?? "";
    const values: string[] = data.data?.values ?? [];
    const channelId = data.channel_id as string | undefined;
    const messageId = data.message?.id as string | undefined;
    const userId = (data.member?.user?.id ?? data.user?.id) as string | undefined;
    const modelPage = parseDiscordModelPageCustomId(customId);
    const providerPage = parseDiscordProviderPageCustomId(customId);
    const isModelPickerInteraction =
      customId === DISCORD_PROVIDER_SELECT_ID ||
      customId === DISCORD_MODEL_SELECT_ID ||
      customId === DISCORD_MODEL_BACK_ID ||
      customId.startsWith("modelpage:") ||
      customId.startsWith("modelprovpage:");
    if (!isModelPickerInteraction) return false;

    if (!channelId || !messageId || !userId) {
      await this.ackInteraction(data, {
        type: 4,
        data: {
          content: "Could not identify this model picker. Run /model again.",
          flags: 64,
        },
      });
      return true;
    }

    const expired = async () => {
      await this.ackInteraction(data, {
        type: 7,
        data: {
          content: "Model list expired. Run /model again.",
          components: [],
        },
      });
    };

    const state = getDiscordModelPickerState(channelId, messageId);
    if (!state) {
      await expired();
      return true;
    }
    if (state.ownerUserId !== userId) {
      await this.ackInteraction(data, {
        type: 4,
        data: {
          content: "This model picker belongs to another user. Run /model to open your own.",
          flags: 64,
        },
      });
      return true;
    }

    if (customId === DISCORD_PROVIDER_SELECT_ID) {
      const provider = resolveDiscordProviderSelection(
        values[0] ?? "",
        listDiscordProviders(state.models),
      );
      if (!provider) {
        await this.ackInteraction(data, { type: 6 });
        return true;
      }
      const next = updateDiscordModelPickerView(channelId, messageId, {
        provider,
        page: 0,
      });
      const payload = buildDiscordModelPicker(next?.models ?? state.models, next?.view ?? {
        provider,
        page: 0,
      });
      await this.ackInteraction(data, { type: 7, data: payload });
      return true;
    }

    if (customId === DISCORD_MODEL_SELECT_ID) {
      const key = resolveDiscordModelSelection(values[0] ?? "", state.models);
      await this.ackInteraction(data, {
        type: 7,
        data: {
          content: key ? `Picked ${key}. Switching…` : "Could not resolve that model.",
          components: [],
        },
      });
      if (key) {
        forgetDiscordModelPicker(channelId, messageId);
        await this.emitCallback(data, `model:${key}`);
      }
      return true;
    }

    if (customId === DISCORD_MODEL_BACK_ID) {
      const next = updateDiscordModelPickerView(channelId, messageId, {
        provider: null,
        page: 0,
      });
      const payload = buildDiscordModelPicker(next?.models ?? state.models, {
        provider: null,
        page: 0,
      });
      await this.ackInteraction(data, { type: 7, data: payload });
      return true;
    }

    if (modelPage) {
      if (modelPage.stay) {
        await this.ackInteraction(data, { type: 6 });
        return true;
      }
      if (!state.view.provider) {
        await expired();
        return true;
      }
      const next = updateDiscordModelPickerView(channelId, messageId, {
        provider: state.view.provider,
        page: modelPage.page,
      });
      const payload = buildDiscordModelPicker(next?.models ?? state.models, next?.view ?? state.view);
      await this.ackInteraction(data, { type: 7, data: payload });
      return true;
    }

    if (providerPage) {
      if (providerPage.stay) {
        await this.ackInteraction(data, { type: 6 });
        return true;
      }
      const next = updateDiscordModelPickerView(channelId, messageId, {
        provider: null,
        page: providerPage.page,
      });
      const payload = buildDiscordModelPicker(next?.models ?? state.models, {
        provider: null,
        page: providerPage.page,
      });
      await this.ackInteraction(data, { type: 7, data: payload });
      return true;
    }

    return false;
  }

  private async emitCallback(data: any, customId: string): Promise<void> {
    const userId = data.member?.user?.id ?? data.user?.id;
    const channelId = data.channel_id;
    if (!userId || !channelId) {
      logger.warn(`[Discord] Unknown interactive custom_id: ${customId}`);
      return;
    }
    const message: PlatformMessage = {
      id: data.id ?? customId,
      platform: this.platform,
      channelId,
      userId,
      content: `Callback: ${customId}`,
      timestamp: Date.now(),
      metadata: {
        guildId: data.guild_id,
        isDM: !data.guild_id,
        callback: true,
        callbackMessageId: data.message?.id,
      },
    };
    // A picker selection replaces its own "Switching…" response with the result.
    const context = { channelId, token: data.token, applicationId: data.application_id ?? this.applicationId ?? this.getBotId(), responded: false };
    await this.slashContext.run(context, async () => {
      await this.emitMessage(message);
      if (!context.responded) await this.sendDiscordMessage(channelId, { content: "❌ 操作未完成，请重新运行相关指令。" });
    });
  }

  private async handleComponentInteraction(data: any): Promise<void> {
    if (await this.handleModelPickerInteraction(data)) return;

    const customId: string = data.data?.custom_id ?? "";
    const parsed = parseDiscordButtonCustomId(customId);
    const userId = data.member?.user?.id ?? data.user?.id;
    if (/^resume:\d+$/.test(customId)) {
      const key = `${data.channel_id}:${data.message?.id}`;
      const picker = this.resumePickers.get(key);
      if (!picker || picker.expiresAt <= Date.now() || picker.owner !== userId) {
        await this.ackInteraction(data, { type: 4, data: { content: picker && picker.expiresAt > Date.now() ? "这个会话列表属于其他用户，请用 /resume 打开自己的列表。" : "会话列表已失效，请重新使用 /resume。", flags: 64 } });
        return;
      }
      this.resumePickers.delete(key);
      await this.ackInteraction(data, { type: 7, data: { content: "⏳ 正在打开所选会话…", components: [] } });
      await this.emitCallback(data, customId);
      return;
    }
    if (customId === "turn:stop") {
      const owner = this.activeReplies.get(`${data.channel_id}:${data.message?.id}`);
      if (!owner || owner !== userId) {
        await this.ackInteraction(data, { type: 4, data: { content: owner ? "只有任务发起者可以使用这个停止按钮。" : "这个任务已经结束。", flags: 64 } });
        return;
      }
      await this.ackInteraction(data, { type: 4, data: { content: "🛑 正在请求停止…", flags: 64 } });
      await this.emitMessage({ id: data.id, platform: this.platform, channelId: data.channel_id, userId,
        content: "/stop", timestamp: Date.now(), metadata: { callback: true, stopButton: true } });
      return;
    }
    const inputId = customId.startsWith("ui:i:") ? customId.slice(5) : null;
    if (parsed || inputId) {
      const requestId = parsed?.requestId ?? inputId!;
      const status = interactiveResponseStatus(requestId, this.platform, data.channel_id, userId, data.message?.id);
      if (status !== "valid") {
        await this.ackInteraction(data, { type: 4, data: {
          content: status === "forbidden" ? "只有发起任务的用户可以回答这个提问。" : "这个提问已结束或超时，请重新触发。",
          flags: 64,
        } });
        return;
      }
      if (inputId) {
        const saved = this.interactiveMessages.get(`${data.channel_id}:${data.message?.id}`);
        if ((saved?.prompt.prefill?.length ?? 0) > 4000) {
          await this.ackInteraction(data, { type: 4, data: { content: "原始内容超过 Discord 表单的 4000 字符限制，不能在表单中完整编辑。请查看上方完整提问内容，并用聊天消息回答。", flags: 64 } });
          return;
        }
        if (!saved) {
          await this.ackInteraction(data, { type: 4, data: { content: "提问已失效，请重新触发。", flags: 64 } });
          return;
        }
        await this.ackInteraction(data, { type: 9, data: buildDiscordInputModal(saved.prompt) });
        return;
      }
      // Defer the component update. The bridge records the answer and clears it.
      await this.ackInteraction(data, { type: 6 });
      this.callbacks?.onInteractiveResponse?.(parsed, userId);
      return;
    }
    await this.ackInteraction(data, { type: 4, data: { content: "这个按钮已失效，请重新运行相关指令。", flags: 64 } });
  }

  private async handleModalInteraction(data: any): Promise<void> {
    const customId = String(data.data?.custom_id ?? "");
    if (!customId.startsWith("ui:input:")) return;
    const requestId = customId.slice(9);
    const userId = data.member?.user?.id ?? data.user?.id;
    const status = interactiveResponseStatus(requestId, this.platform, data.channel_id, userId, data.message?.id);
    if (status !== "valid") {
      await this.ackInteraction(data, { type: 4, data: { content: status === "forbidden" ? "只有发起任务的用户可以回答。" : "提问已结束或超时，回答未提交。", flags: 64 } });
      return;
    }
    const field = data.data?.components?.flatMap((row: any) => row.components ?? []).find((component: any) => component.custom_id === "answer");
    if (typeof field?.value !== "string" || field.value.length > 4000) {
      await this.ackInteraction(data, { type: 4, data: { content: "没有收到有效回答，请重试。", flags: 64 } });
      return;
    }
    const accepted = this.callbacks?.onInteractiveResponse?.({ requestId, value: field.value }, userId);
    await this.ackInteraction(data, { type: 4, data: { content: accepted === false ? "提问已结束，回答未提交。" : "✅ 回答已提交。", flags: 64 } });
  }

  async sendInteractive(
    channelId: string,
    prompt: InteractivePrompt,
  ): Promise<{ messageId: string }> {
    const payload = buildDiscordInteractiveMessage(prompt);
    const details = [prompt.title, prompt.message, prompt.placeholder, ...(prompt.options ?? []).map((option, index) => `${index + 1}. ${option}`), prompt.prefill].filter(Boolean).join("\n\n");
    if (details.length > 1700) {
      try {
        await this.sendTextAttachment(channelId, details, "完整显示内容见附件。", "prompt.txt");
      } catch (error) {
        logger.warn("[Discord] Full prompt attachment unavailable; displaying complete text:", error);
        await this.sendMessage(channelId, details);
      }
    }
    if (!payload.content && payload.components.length === 0) {
      return { messageId: "0" };
    }
    const messageId = await this.sendDiscordMessage(channelId, payload);
    if (["select", "confirm", "input", "editor"].includes(prompt.method)) {
      this.interactiveMessages.set(`${channelId}:${messageId}`, { prompt, content: payload.content });
    }
    return { messageId };
  }

  override async cleanupInteractive(
    channelId: string,
    messageId: string,
    outcome?: InteractiveOutcome,
  ): Promise<void> {
    if (!messageId || messageId === "0") return;
    const key = `${channelId}:${messageId}`;
    const saved = this.interactiveMessages.get(key);
    this.interactiveMessages.delete(key);
    const note = outcome?.status === "answered"
      ? `✅ ${outcome.label ? `已选择：${outcome.label}` : "回答已提交。"}`
      : outcome?.status === "expired" ? "⌛ 提问已超时。" : "🛑 提问已取消。";
    try {
      await this.requestDiscordWithRetry(`/channels/${channelId}/messages/${messageId}`, {
        method: "PATCH",
        body: JSON.stringify({ components: [], ...(saved ? { content: `${truncateDiscordContent(saved.content, 1700)}\n\n${note.slice(0, 250)}` } : {}), allowed_mentions: { parse: [], replied_user: false } }),
      }, "clear interactive components");
    } catch (error) {
      logger.warn("[Discord] Failed to clear interactive components:", error);
    }
  }

  async sendMessage(channelId: string, content: string): Promise<string> {
    const chunks = splitDiscordContent(content);
    if (chunks.length === 0) {
      throw new Error("Refusing to send an empty Discord message");
    }
    if (chunks.length > DiscordAdapter.MAX_SPLIT_MESSAGES || chunks.some((chunk) => !chunk.trim())) {
      try {
        return await this.sendTextAttachment(channelId, content, "📄 内容较长，完整文本见附件。");
      } catch (error) {
        logger.warn("[Discord] Long response attachment unavailable; sending complete text chunks:", error);
        if (chunks.some((chunk) => !chunk.trim())) throw error;
      }
    }
    let lastId = "";
    for (const chunk of chunks) {
      if (lastId) {
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      try {
        lastId = await this.sendDiscordMessage(channelId, { content: chunk });
      } catch (error) {
        logger.warn("[Discord] Text delivery failed; trying complete attachment:", error);
        return await this.sendTextAttachment(channelId, content, "⚠️ 文本发送失败，完整内容见附件。请以附件为准。");
      }
    }
    return lastId;
  }

  private async sendTextAttachment(channelId: string, content: string, note: string, filename = "response.txt"): Promise<string> {
    const body = new FormData();
    body.append("payload_json", JSON.stringify({ content: note, allowed_mentions: { parse: [], replied_user: false }, attachments: [{ id: 0, filename }] }));
    body.append("files[0]", new Blob([content], { type: "text/plain;charset=utf-8" }), filename);
    return this.sendDiscordPayload(channelId, body);
  }

  async sendReply(message: PlatformMessage, content: string): Promise<string> {
    const messageId = await this.sendDiscordMessage(message.channelId, {
      content: truncateDiscordContent(content),
      components: [{ type: 1, components: [{ type: 2, style: 2, label: "停止任务", custom_id: "turn:stop" }] }],
      ...(!message.metadata?.slashCommand && !message.metadata?.callback ? {
        message_reference: { message_id: message.id, fail_if_not_exists: false },
      } : {}),
    });
    this.activeReplies.set(`${message.channelId}:${messageId}`, message.userId);
    return messageId;
  }

  async setMessageReaction(channelId: string, messageId: string, emoji: string, enabled: boolean): Promise<void> {
    if (this.config.reactions === false) return;
    await this.requestDiscordWithRetry(`/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
      { method: enabled ? "PUT" : "DELETE" }, "update reaction");
  }

  async sendButtons(
    channelId: string,
    text: string,
    buttons: Array<Array<{ text: string; data: string }>>,
    ownerUserId?: string,
  ): Promise<string> {
    if (text.length > 1700) {
      try {
        await this.sendTextAttachment(channelId, text, "📄 完整列表见附件；下方按钮用于选择。", "choices.txt");
      } catch (error) {
        logger.warn("[Discord] Full choice list attachment unavailable; sending complete text:", error);
        await this.sendMessage(channelId, text);
      }
    }
    if (buttons.some((row) => row.some((button) => button.data.length > 100))) throw new Error("Discord button custom_id exceeds 100 characters");
    const components = buttons.slice(0, 5).map((row) => ({
      type: 1 as const,
      components: row.slice(0, 5).map((button) => ({
        type: 2 as const,
        style: 2,
        label: truncateDiscordLabel(button.text),
        custom_id: button.data,
      })),
    }));
    const messageId = await this.sendDiscordMessage(channelId, {
      content: truncateDiscordContent(text),
      components,
    });
    if (ownerUserId && buttons.some((row) => row.some((button) => button.data.startsWith("resume:")))) {
      this.resumePickers.set(`${channelId}:${messageId}`, { owner: ownerUserId, expiresAt: Date.now() + 5 * 60_000 });
      if (this.resumePickers.size > 256) this.resumePickers.delete(this.resumePickers.keys().next().value!);
    }
    return messageId;
  }

  async sendModelPicker(
    channelId: string,
    ownerUserId: string,
    models: CatalogModel[],
  ): Promise<string> {
    const payload = buildDiscordModelPicker(models);
    const messageId = await this.sendDiscordMessage(channelId, payload);
    rememberDiscordModelPicker(channelId, messageId, ownerUserId, models);
    return messageId;
  }

  private async sendDiscordMessage(
    channelId: string,
    body: { content: string; components?: ReturnType<typeof buildDiscordInteractiveMessage>["components"]; message_reference?: { message_id: string; fail_if_not_exists: boolean } },
  ): Promise<string> {
    try {
      return await this.sendDiscordPayload(channelId, JSON.stringify({ ...body, allowed_mentions: { parse: [], replied_user: false } }));
    } catch (error) {
      const detail = String(error);
      // Retry explicit reference rejection only; an ambiguous POST failure may already have delivered.
      if (!body.message_reference || !(/"code"\s*:\s*10008\b/.test(detail) || (/"code"\s*:\s*50035\b/.test(detail) && /message_reference|Cannot reply to a system message/i.test(detail)))) throw error;
      const { message_reference: _reference, ...withoutReference } = body;
      return this.sendDiscordPayload(channelId, JSON.stringify({ ...withoutReference, allowed_mentions: { parse: [], replied_user: false } }));
    }
  }

  private async sendDiscordPayload(channelId: string, body: string | FormData): Promise<string> {
    const context = this.slashContext.getStore();
    const useOriginal = context?.channelId === channelId && !context.responded;
    if (useOriginal) context.responded = true;
    let response: Response;
    try {
      response = await this.requestDiscordWithRetry(
        useOriginal ? `/webhooks/${context.applicationId}/${context.token}/messages/@original` : `/channels/${channelId}/messages`,
        {
          method: useOriginal ? "PATCH" : "POST",
          body,
        },
        "send message",
      );
    } catch (error) {
      if (useOriginal) context.responded = false;
      throw error;
    }
    const data = (await response.json()) as { id: string };
    return data.id;
  }

  private async requestDiscordWithRetry(
    endpoint: string,
    options: RequestInit,
    action: string,
  ): Promise<Response> {
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await this.apiRequest(endpoint, options);
      if (response.ok) return response;
      const error = await response.text();
      const waitMs = discordRetryAfterMs(response.status, error);
      if (waitMs !== null && attempt < maxAttempts) {
        logger.warn(
          `[Discord] ${action} rate limited, retrying in ${waitMs}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
      if (response.status >= 500 && ["PATCH", "PUT", "DELETE"].includes(String(options.method)) && attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        continue;
      }
      throw new Error(`Failed to ${action}: ${error}`);
    }
    throw new Error(`Failed to ${action}: exhausted Discord retries`);
  }

  async editMessage(channelId: string, messageId: string, content: string, options?: MessageEditOptions): Promise<void | MessageDelivery> {
    const key = `${channelId}:${messageId}`;
    const preview = options?.finalize === false;
    let chunks = preview ? [truncateDiscordContent(content)] : splitDiscordContent(content);
    if (!preview && (chunks.length > DiscordAdapter.MAX_SPLIT_MESSAGES || chunks.some((chunk) => !chunk.trim()))) {
      try {
        await this.sendTextAttachment(channelId, content, "📄 完整回复见附件。");
        chunks = ["📄 回复较长，完整文本已发送为附件。"];
      } catch (error) {
        logger.warn("[Discord] Long response attachment unavailable; retaining complete text delivery:", error);
        if (chunks.some((chunk) => !chunk.trim())) throw error;
      }
    }
    if (chunks.length === 0) {
      return;
    }
    if (preview && this.previews.get(key) === chunks[0]) return;
    await this.requestDiscordWithRetry(
      `/channels/${channelId}/messages/${messageId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ content: chunks[0], ...(!preview && this.activeReplies.has(key) ? { components: [] } : {}), allowed_mentions: { parse: [], replied_user: false } }),
      },
      "edit message",
    );
    if (preview) {
      this.previews.set(key, chunks[0]);
      if (this.previews.size > 256) this.previews.delete(this.previews.keys().next().value!);
      return;
    }
    this.previews.delete(key);
    this.activeReplies.delete(key);
    const overflow = this.overflowMessages.get(key) ?? [];
    this.overflowMessages.set(key, overflow);
    if (this.overflowMessages.size > 256) this.overflowMessages.delete(this.overflowMessages.keys().next().value!);
    for (let index = 1; index < chunks.length; index++) {
      try {
        if (index > 1) await new Promise((resolve) => setTimeout(resolve, 350));
        if (overflow[index - 1]) {
          await this.requestDiscordWithRetry(`/channels/${channelId}/messages/${overflow[index - 1]}`, {
            method: "PATCH", body: JSON.stringify({ content: chunks[index], allowed_mentions: { parse: [], replied_user: false } }),
          }, "edit continuation");
        } else {
          overflow.push(await this.sendDiscordMessage(channelId, { content: chunks[index],
            message_reference: { message_id: overflow.at(-1) ?? messageId, fail_if_not_exists: false } }));
        }
      } catch (error) {
        try {
          await this.sendTextAttachment(channelId, content, "⚠️ 分段发送失败，完整回复见附件。前面已发送的段落保留。请以附件为准。");
          return { partial: false, deliveredChunks: chunks.length, totalChunks: chunks.length };
        } catch (attachmentError) {
          logger.error("[Discord] Complete response attachment also failed:", attachmentError);
        }
        // The first chunk is already visible. Throwing here makes the caller
        // resend the entire response and duplicate all delivered chunks.
        logger.error(
          "[Discord] Response was only partially delivered; not resending the prefix:",
          error,
        );
        return { partial: true, deliveredChunks: index, totalChunks: chunks.length };
      }
    }
    for (const obsolete of overflow.splice(chunks.length - 1)) {
      await this.deleteMessage(channelId, obsolete).catch((error) => logger.warn("[Discord] Could not remove an obsolete continuation:", error));
    }
    return { partial: false, deliveredChunks: chunks.length, totalChunks: chunks.length };
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    await this.requestDiscordWithRetry(`/channels/${channelId}/messages/${messageId}`, {
      method: "DELETE",
    }, "delete message");
    const key = `${channelId}:${messageId}`;
    this.activeReplies.delete(key);
    this.previews.delete(key);
    this.overflowMessages.delete(key);
    this.interactiveMessages.delete(key);
    this.resumePickers.delete(key);
  }

  async setTyping(channelId: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return; // Discord doesn't have a "stop typing" API
    
    await this.apiRequest(`/channels/${channelId}/typing`, {
      method: "POST",
    });
  }

  async getStatus(): Promise<{ connected: boolean; latency?: number }> {
    return {
      connected:
        this.running && this.wsConnection?.readyState === WebSocket.OPEN,
    };
  }

  async stop(): Promise<void> {
    await super.stop();
    this.clearReconnectTimer();
    this.teardownSocket();
    this.interactiveMessages.clear();
    this.previews.clear();
    this.overflowMessages.clear();
    this.activeReplies.clear();
    this.resumePickers.clear();
  }

  // Helper to register slash commands
  async registerDefaultSlashCommands(): Promise<void> {
    const applicationId = this.applicationId ?? this.getBotId();
    const commands = DISCORD_SLASH_COMMANDS;
    const response = await this.apiRequest(`/applications/${applicationId}/commands`, {
      method: "PUT",
      body: JSON.stringify(commands),
    });
    if (!response.ok) {
      const detail = await response.text();
      logger.error(`[Discord] Global slash command registration failed: ${response.status} ${detail}`);
      return;
    }
    if (this.config.guildId) {
      const guildResponse = await this.apiRequest(
        `/applications/${applicationId}/guilds/${this.config.guildId}/commands`,
        {
          method: "PUT",
          body: JSON.stringify(commands),
        },
      );
      if (!guildResponse.ok) {
        logger.warn(
          `[Discord] Guild slash command registration failed: ${guildResponse.status}`,
        );
      }
    }
    logger.info(`[Discord] Registered ${commands.length} slash commands`);
  }

  async registerSlashCommands(commands: Array<{
    name: string;
    description: string;
    options?: any[];
  }>): Promise<void> {
    const applicationId = this.applicationId ?? this.getBotId();
    const path = this.config.guildId
      ? `/applications/${applicationId}/guilds/${this.config.guildId}/commands`
      : `/applications/${applicationId}/commands`;
    await this.apiRequest(path, {
      method: "PUT",
      body: JSON.stringify(commands),
    });
    logger.info(`[Discord] Registered ${commands.length} slash commands`);
  }
}
