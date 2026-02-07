/**
 * External Messages HTTP Endpoint for Telegram
 *
 * Plan C v2: External messages are injected as synthetic Telegram Updates
 * and processed through the bot's normal message pipeline (bot.on('message')).
 * This means they go through the full envelope → context → history flow,
 * appearing identical to native Telegram messages from the AI's perspective.
 *
 * POST /api/telegram/external-messages
 * - Receives messages from external bots (e.g., Telethon userbot)
 * - Constructs a synthetic Telegram Update object
 * - Feeds it through bot.handleUpdate() for full pipeline processing
 * - Requires Bearer token authentication
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Update, Message, Chat, User } from "@grammyjs/types";
import type { Bot } from "grammy";
import type { EnvelopeFormatOptions } from "../auto-reply/envelope.js";
import { resolveEnvelopeFormatOptions } from "../auto-reply/envelope.js";
import { loadConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type ExternalMessagePayload = {
  /** Telegram chat ID (negative for groups) */
  chatId: number | string;
  /** Message ID in the chat */
  messageId: number | string;
  /** Display name of the sender */
  senderName: string;
  /** Username of the sender (without @) */
  senderUsername?: string;
  /** Sender's user ID */
  senderId?: number | string;
  /** Message text content */
  text: string;
  /** Unix timestamp in seconds */
  timestamp: number;
  /** Optional reply-to message ID */
  replyToMessageId?: number | string;
  /** Optional forum topic ID (for supergroups with topics) */
  topicId?: number;
  /** Account ID for multi-account setups */
  accountId?: string;
};

export type ExternalMessagesConfig = {
  /** Shared secret for authentication */
  secret: string;
  /** History limit (max entries to keep) */
  historyLimit: number;
  /** Envelope format options */
  envelopeOptions?: EnvelopeFormatOptions;
};

// -----------------------------------------------------------------------------
// Registry: Store bot instances and configs by accountId
// -----------------------------------------------------------------------------

const botRegistry = new Map<string, Bot>();
const configRegistry = new Map<string, ExternalMessagesConfig>();

/** Counter for generating unique synthetic update IDs (negative to avoid clashing with real ones) */
let syntheticUpdateCounter = -1;

/**
 * Register a bot instance for external message injection.
 * Called when the bot starts.
 */
export function registerBotForExternalMessages(
  accountId: string,
  bot: Bot,
  config: ExternalMessagesConfig,
): void {
  botRegistry.set(accountId, bot);
  configRegistry.set(accountId, config);
  logVerbose(`telegram: registered external-messages handler for account ${accountId}`);
}

/**
 * Unregister a bot instance when the bot stops.
 */
export function unregisterBotForExternalMessages(accountId: string): void {
  botRegistry.delete(accountId);
  configRegistry.delete(accountId);
  logVerbose(`telegram: unregistered external-messages handler for account ${accountId}`);
}

// Keep backward-compatible exports for bot.ts (groupHistories registration is no longer needed
// but we keep the function signatures to avoid breaking imports during transition).
// biome-ignore lint/suspicious/noExplicitAny: backward compat
export function registerGroupHistories(_accountId: string, _historyMap: any, _config: any): void {
  // No-op: replaced by registerBotForExternalMessages
}
export function unregisterGroupHistories(_accountId: string): void {
  // No-op: replaced by unregisterBotForExternalMessages
}

// -----------------------------------------------------------------------------
// HTTP Handler
// -----------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalLength = 0;

    req.on("data", (chunk: Buffer) => {
      totalLength += chunk.length;
      if (totalLength > maxBytes) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error(`Invalid JSON: ${String(err)}`));
      }
    });

    req.on("error", reject);
  });
}

function extractToken(req: IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  const tokenHeader = req.headers["x-openclaw-token"];
  if (typeof tokenHeader === "string") {
    return tokenHeader.trim();
  }
  return null;
}

function validatePayload(payload: unknown): payload is ExternalMessagePayload {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const p = payload as Record<string, unknown>;
  if (p.chatId == null) return false;
  if (p.messageId == null) return false;
  if (typeof p.senderName !== "string" || !p.senderName.trim()) return false;
  if (typeof p.text !== "string") return false;
  if (typeof p.timestamp !== "number") return false;
  return true;
}

/**
 * Build a synthetic Telegram Update from the external payload.
 * The update looks like a real Telegram message so it flows through
 * the full bot.on('message') pipeline.
 */
function buildSyntheticUpdate(payload: ExternalMessagePayload): Update {
  const updateId = syntheticUpdateCounter--;
  const chatId = Number(payload.chatId);
  const messageId = Number(payload.messageId);
  const senderId = payload.senderId ? Number(payload.senderId) : 0;
  const firstName = payload.senderName.trim();

  const from: User = {
    id: senderId,
    is_bot: false,
    first_name: firstName,
    ...(payload.senderUsername ? { username: payload.senderUsername } : {}),
  };

  // Groups have negative chat IDs; build appropriate chat type
  const isGroup = chatId < 0;
  const chat: Chat = isGroup
    ? ({
        id: chatId,
        type: "supergroup" as const,
        title: `Chat ${chatId}`,
      } as Chat)
    : ({
        id: chatId,
        type: "private" as const,
        first_name: firstName,
      } as Chat);

  const message: Message = {
    message_id: messageId,
    date: payload.timestamp,
    chat,
    from,
    text: payload.text,
    ...(payload.replyToMessageId
      ? {
          reply_to_message: {
            message_id: Number(payload.replyToMessageId),
            date: payload.timestamp,
            chat,
          } as Message,
        }
      : {}),
    ...(payload.topicId ? { message_thread_id: payload.topicId } : {}),
  };

  return {
    update_id: updateId,
    message,
  };
}

/**
 * Handle external message injection request.
 *
 * POST /api/telegram/external-messages
 */
export async function handleExternalMessagesRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname !== "/api/telegram/external-messages") {
    return false;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  // Reject tokens in query params
  if (url.searchParams.has("token") || url.searchParams.has("secret")) {
    sendJson(res, 400, {
      ok: false,
      error:
        "Token must be provided via Authorization: Bearer <token> or X-OpenClaw-Token header (query parameters are not allowed)",
    });
    return true;
  }

  const token = extractToken(req);
  if (!token) {
    sendJson(res, 401, { ok: false, error: "Missing authentication token" });
    return true;
  }

  let payload: unknown;
  try {
    payload = await readJsonBody(req);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Invalid request body";
    sendJson(res, 400, { ok: false, error: errMsg });
    return true;
  }

  if (!validatePayload(payload)) {
    sendJson(res, 400, {
      ok: false,
      error: "Invalid payload: required fields are chatId, messageId, senderName, text, timestamp",
    });
    return true;
  }

  const accountId = payload.accountId?.trim() || "default";

  const bot = botRegistry.get(accountId);
  const config = configRegistry.get(accountId);

  if (!bot || !config) {
    sendJson(res, 503, {
      ok: false,
      error: `No Telegram bot running for account "${accountId}"`,
    });
    return true;
  }

  if (token !== config.secret) {
    sendJson(res, 401, { ok: false, error: "Invalid authentication token" });
    return true;
  }

  // Build synthetic update and feed it through the bot's pipeline
  const syntheticUpdate = buildSyntheticUpdate(payload);

  logVerbose(
    `telegram: injecting external message for chat ${payload.chatId}: ${payload.senderName}: ${payload.text.slice(0, 50)}...`,
  );

  try {
    await bot.handleUpdate(syntheticUpdate);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logVerbose(`telegram: external message processing error: ${errMsg}`);
    sendJson(res, 500, { ok: false, error: `Processing failed: ${errMsg}` });
    return true;
  }

  sendJson(res, 200, {
    ok: true,
    updateId: syntheticUpdate.update_id,
    messageId: payload.messageId,
    chatId: payload.chatId,
  });

  return true;
}

/**
 * Resolve external messages configuration from OpenClaw config.
 */
export function resolveExternalMessagesConfig(
  accountId: string,
): ExternalMessagesConfig | null {
  const cfg = loadConfig();

  const telegramConfig = cfg.channels?.telegram;
  if (!telegramConfig) {
    return null;
  }

  const accountConfig = telegramConfig.accounts?.[accountId];
  const externalConfig =
    (accountConfig as Record<string, unknown>)?.externalMessages ??
    (telegramConfig as Record<string, unknown>)?.externalMessages;

  if (!externalConfig || typeof externalConfig !== "object") {
    return null;
  }

  const config = externalConfig as Record<string, unknown>;
  const secret = config.secret;

  if (typeof secret !== "string" || !secret.trim()) {
    return null;
  }

  const historyLimit =
    typeof config.historyLimit === "number"
      ? config.historyLimit
      : telegramConfig.historyLimit ?? cfg.messages?.groupChat?.historyLimit ?? 50;

  return {
    secret: secret.trim(),
    historyLimit,
    envelopeOptions: resolveEnvelopeFormatOptions(cfg),
  };
}
