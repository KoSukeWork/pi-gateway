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
  parseDiscordButtonCustomId,
} from "./discord-interactive.js";

export interface DiscordConfig extends PlatformConfig {
  platform: "discord";
  botToken: string;
  guildId?: string;
  allowedChannels?: string[];  // Whitelist specific channels
  allowedRoles?: string[];     // Whitelist roles
  requireMention?: boolean;    // Require @mention in guilds
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

    // Connect to Gateway
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

    this.wsConnection.onclose = () => {
      logger.info("[Discord] WebSocket closed");
      this.callbacks?.onDisconnect?.();
      // Attempt reconnect after 5 seconds
      setTimeout(() => this.start(callbacks), 5000);
    };
  }

  private async handleGatewayMessage(data: any): Promise<void> {
    switch (data.op) {
      case 0: // Dispatch
        this.sequence = data.s;
        await this.handleDispatch(data.t, data.d);
        break;
        
      case 10: // Hello
        this.startHeartbeat(data.d.heartbeat_interval);
        this.identify();
        break;
        
      case 11: // Heartbeat ACK
        // Heartbeat acknowledged
        break;
    }
  }

  private startHeartbeat(interval: number): void {
    this.heartbeatInterval = setInterval(() => {
      if (this.wsConnection?.readyState === WebSocket.OPEN) {
        this.wsConnection.send(JSON.stringify({
          op: 1,
          d: this.sequence,
        }));
      }
    }, interval);
  }

  private async identify(): Promise<void> {
    const identifyPayload = {
      op: 2,
      d: {
        token: this.config.botToken,
        intents: this.intents,
        properties: {
          os: "linux",
          browser: "pi-gateway",
          device: "pi-gateway",
        },
      },
    };
    
    this.wsConnection?.send(JSON.stringify(identifyPayload));
  }

  private async handleDispatch(type: string, data: any): Promise<void> {
    switch (type) {
      case "READY":
        this.sessionId = data.session_id;
        this.botUserId = data.user?.id ?? null;
        this.applicationId = data.application?.id ?? data.user?.id ?? null;
        logger.info(`[Discord] Logged in as ${data.user.username}`);
        await this.registerDefaultSlashCommands();
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
    // Ignore bots
    if (data.author.bot && data.author.id !== this.getBotId()) return;
    
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

    await this.callbacks?.onMessage(message);
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

    if (!parsed) {
      logger.warn(`[Discord] Unknown interactive custom_id: ${customId}`);
      return;
    }
    this.callbacks?.onInteractiveResponse?.(parsed, userId);
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
    return this.sendDiscordMessage(channelId, { content });
  }

  private async sendDiscordMessage(
    channelId: string,
    body: { content: string; components?: ReturnType<typeof buildDiscordInteractiveMessage>["components"] },
  ): Promise<string> {
    const response = await this.apiRequest(`/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to send message: ${error}`);
    }

    const data = (await response.json()) as { id: string };
    return data.id;
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
    await this.apiRequest(`/channels/${channelId}/messages/${messageId}`, {
      method: "PATCH",
      body: JSON.stringify({ content }),
    });
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
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    if (this.wsConnection) {
      this.wsConnection.close();
    }
    await super.stop();
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
