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
} from "./base.js";
import { logger } from "../logger.js";
import { DISCORD_SLASH_COMMANDS, slashInteractionToContent } from "./slash-commands.js";
import {
  buildDiscordInteractiveMessage,
  discordRetryAfterMs,
  parseDiscordButtonCustomId,
  splitDiscordContent,
  truncateDiscordContent,
  truncateDiscordLabel,
} from "./discord-interactive.js";
import {
  buildDiscordHeartbeat,
  buildDiscordIdentify,
  buildDiscordResume,
  canResumeDiscordSession,
  discordReconnectDelayMs,
  isDiscordFatalClose,
} from "./discord-gateway.js";

export interface DiscordConfig extends PlatformConfig {
  platform: "discord";
  botToken: string;
  guildId?: string;
  allowedChannels?: string[];  // Whitelist specific channels
  allowedRoles?: string[];     // Whitelist roles
  requireMention?: boolean;    // Require @mention in guilds
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
  private heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private lastCloseCode: number | null = null;

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
      headers: {
        "Authorization": `Bot ${this.config.botToken}`,
        "Content-Type": "application/json",
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
      const data: any = JSON.parse(event.data);
      await this.handleGatewayMessage(data);
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
    this.heartbeatAcked = true;
    const delay = Math.max(0, interval * Math.random());
    this.heartbeatTimeout = setTimeout(() => {
      this.heartbeatTimeout = null;
      this.sendHeartbeat();
      this.heartbeatInterval = setInterval(() => this.sendHeartbeat(), interval);
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

    // Check if DM or allowed channel
    const isDM = !data.guild_id;
    if (!isDM && this.config.allowedChannels?.length) {
      if (!this.config.allowedChannels.includes(data.channel_id)) return;
    }

    // Check mention requirement in guilds
    if (!isDM && this.config.requireMention) {
      const mentioned = data.content.includes(`<@${this.getBotId()}>`);
      if (!mentioned) return;
    }

    const message: PlatformMessage = {
      id: data.id,
      platform: this.platform,
      channelId: data.channel_id,
      userId: data.author.id,
      content: data.content,
      timestamp: new Date(data.timestamp).getTime(),
      metadata: {
        guildId: data.guild_id,
        username: data.author.username,
        discriminator: data.author.discriminator,
        isDM,
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
      await this.apiRequest(`/interactions/${data.id}/${data.token}/callback`, {
        method: "POST",
        body: JSON.stringify({ type: 5 }),
      });
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
    await this.callbacks?.onMessage(message);
  }

  private async handleComponentInteraction(data: any): Promise<void> {
    const customId: string = data.data?.custom_id ?? "";
    const parsed = parseDiscordButtonCustomId(customId);
    const userId = data.member?.user?.id ?? data.user?.id;

    try {
      await this.apiRequest(`/interactions/${data.id}/${data.token}/callback`, {
        method: "POST",
        body: JSON.stringify({
          type: 7,
          data: { components: [] },
        }),
      });
    } catch (error) {
      logger.error("[Discord] Failed to acknowledge button interaction:", error);
    }

    if (parsed) {
      this.callbacks?.onInteractiveResponse?.(parsed, userId);
      return;
    }
    const channelId = data.channel_id;
    if (!userId || !channelId || !customId) {
      logger.warn(`[Discord] Unknown interactive custom_id: ${customId}`);
      return;
    }
    await this.emitMessage({
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
      },
    });
  }

  async sendInteractive(
    channelId: string,
    prompt: InteractivePrompt,
  ): Promise<{ messageId: string }> {
    const payload = buildDiscordInteractiveMessage(prompt);
    if (!payload.content && payload.components.length === 0) {
      return { messageId: "0" };
    }
    const messageId = await this.sendDiscordMessage(channelId, payload);
    return { messageId };
  }

  override async cleanupInteractive(
    channelId: string,
    messageId: string,
  ): Promise<void> {
    if (!messageId || messageId === "0") return;
    try {
      await this.apiRequest(`/channels/${channelId}/messages/${messageId}`, {
        method: "PATCH",
        body: JSON.stringify({ components: [] }),
      });
    } catch (error) {
      logger.warn("[Discord] Failed to clear interactive components:", error);
    }
  }

  async sendMessage(channelId: string, content: string): Promise<string> {
    const chunks = splitDiscordContent(content);
    if (chunks.length === 0) {
      throw new Error("Refusing to send an empty Discord message");
    }
    let lastId = "";
    for (const chunk of chunks) {
      if (lastId) {
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      lastId = await this.sendDiscordMessage(channelId, { content: chunk });
    }
    return lastId;
  }

  async sendButtons(
    channelId: string,
    text: string,
    buttons: Array<Array<{ text: string; data: string }>>,
  ): Promise<string> {
    const components = buttons.slice(0, 5).map((row) => ({
      type: 1 as const,
      components: row.slice(0, 5).map((button) => ({
        type: 2 as const,
        style: 2,
        label: truncateDiscordLabel(button.text),
        custom_id: button.data.slice(0, 100),
      })),
    }));
    return this.sendDiscordMessage(channelId, {
      content: truncateDiscordContent(text),
      components,
    });
  }

  private async sendDiscordMessage(
    channelId: string,
    body: { content: string; components?: ReturnType<typeof buildDiscordInteractiveMessage>["components"] },
  ): Promise<string> {
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await this.apiRequest(`/channels/${channelId}/messages`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (response.ok) {
        const data = (await response.json()) as { id: string };
        return data.id;
      }
      const error = await response.text();
      const waitMs = discordRetryAfterMs(response.status, error);
      if (waitMs !== null && attempt < maxAttempts) {
        logger.warn(`[Discord] Rate limited, retrying in ${waitMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
      throw new Error(`Failed to send message: ${error}`);
    }
    throw new Error("Failed to send message: exhausted Discord retries");
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
    const chunks = splitDiscordContent(content);
    if (chunks.length === 0) {
      return;
    }
    const response = await this.apiRequest(`/channels/${channelId}/messages/${messageId}`, {
      method: "PATCH",
      body: JSON.stringify({ content: chunks[0] }),
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to edit message: ${error}`);
    }
    for (const extra of chunks.slice(1)) {
      await this.sendDiscordMessage(channelId, { content: extra });
    }
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    await this.apiRequest(`/channels/${channelId}/messages/${messageId}`, {
      method: "DELETE",
    });
  }

  async setTyping(channelId: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return; // Discord doesn't have a "stop typing" API
    
    await this.apiRequest(`/channels/${channelId}/typing`, {
      method: "POST",
    });
  }

  async getStatus(): Promise<{ connected: boolean; latency?: number }> {
    try {
      const response = await this.apiRequest("/gateway/bot");
      const data: any = await response.json();
      return {
        connected: true,
        latency: data.session_start_limit?.remaining ?? undefined,
      };
    } catch {
      return { connected: false };
    }
  }

  async stop(): Promise<void> {
    await super.stop();
    this.clearReconnectTimer();
    this.teardownSocket();
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
