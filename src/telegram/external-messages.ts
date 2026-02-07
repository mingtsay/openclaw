/**
 * External Messages HTTP Endpoint for Telegram
 *
 * This module provides an HTTP endpoint that allows external services (e.g., Telethon userbot)
 * to inject messages into the group history buffer without triggering AI responses.
 *
 * Plan C Implementation:
 * - POST /api/telegram/external-messages
 * - Receives messages from external bots observing conversations
 * - Writes to groupHistories for context, but doesn't trigger AI replies
 * - Requires shared secret authentication
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { HistoryEntry } from "../auto-reply/reply/history.js";
import type { EnvelopeFormatOptions } from "../auto-reply/envelope.js";
import { recordPendingHistoryEntryIfEnabled } from "../auto-reply/reply/history.js";
import { formatInboundEnvelope, resolveEnvelopeFormatOptions } from "../auto-reply/envelope.js";
import { loadConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import { buildTelegramGroupPeerId } from "./bot/helpers.js";

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
// Registry: Store groupHistories by accountId
// -----------------------------------------------------------------------------

const groupHistoriesRegistry = new Map<string, Map<string, HistoryEntry[]>>();
const configRegistry = new Map<string, ExternalMessagesConfig>();

/**
 * Register a groupHistories map for a Telegram account.
 * Called when the bot starts.
 */
export function registerGroupHistories(
  accountId: string,
  historyMap: Map<string, HistoryEntry[]>,
  config: ExternalMessagesConfig,
): void {
  groupHistoriesRegistry.set(accountId, historyMap);
  configRegistry.set(accountId, config);
  logVerbose(`telegram: registered external-messages handler for account ${accountId}`);
}

/**
 * Unregister a groupHistories map when the bot stops.
 */
export function unregisterGroupHistories(accountId: string): void {
  groupHistoriesRegistry.delete(accountId);
  configRegistry.delete(accountId);
  logVerbose(`telegram: unregistered external-messages handler for account ${accountId}`);
}

/**
 * Get the groupHistories map for an account.
 */
export function getGroupHistories(accountId: string): Map<string, HistoryEntry[]> | undefined {
  return groupHistoriesRegistry.get(accountId);
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
  // Check Authorization: Bearer <token>
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  // Check X-OpenClaw-Token header
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

  // Required fields
  if (p.chatId == null) return false;
  if (p.messageId == null) return false;
  if (typeof p.senderName !== "string" || !p.senderName.trim()) return false;
  if (typeof p.text !== "string") return false;
  if (typeof p.timestamp !== "number") return false;

  return true;
}

function buildSenderLabel(payload: ExternalMessagePayload): string {
  const name = payload.senderName.trim();
  const username = payload.senderUsername?.trim();
  const id = payload.senderId;

  if (username && id) {
    return `${name} (@${username} id:${id})`;
  }
  if (username) {
    return `${name} (@${username})`;
  }
  if (id) {
    return `${name} (id:${id})`;
  }
  return name;
}

/**
 * Handle external message injection request.
 *
 * POST /api/telegram/external-messages
 *
 * Headers:
 *   - Authorization: Bearer <secret>
 *   - X-OpenClaw-Token: <secret>
 *
 * Body (JSON):
 *   {
 *     chatId: number | string,
 *     messageId: number | string,
 *     senderName: string,
 *     senderUsername?: string,
 *     senderId?: number | string,
 *     text: string,
 *     timestamp: number,
 *     replyToMessageId?: number | string,
 *     topicId?: number,
 *     accountId?: string
 *   }
 *
 * Response:
 *   { ok: true, historyKey: string, entriesCount: number }
 *   { ok: false, error: string }
 */
export async function handleExternalMessagesRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");

  // Only handle our specific path
  if (url.pathname !== "/api/telegram/external-messages") {
    return false;
  }

  // Method check
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  // Require token in headers (not query params for security)
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

  // Parse request body
  let payload: unknown;
  try {
    payload = await readJsonBody(req);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Invalid request body";
    sendJson(res, 400, { ok: false, error: errMsg });
    return true;
  }

  // Validate payload structure
  if (!validatePayload(payload)) {
    sendJson(res, 400, {
      ok: false,
      error: "Invalid payload: required fields are chatId, messageId, senderName, text, timestamp",
    });
    return true;
  }

  // Resolve account
  const accountId = payload.accountId?.trim() || "default";

  // Check if we have a registered handler for this account
  const historyMap = groupHistoriesRegistry.get(accountId);
  const config = configRegistry.get(accountId);

  if (!historyMap || !config) {
    sendJson(res, 503, {
      ok: false,
      error: `No Telegram bot running for account "${accountId}"`,
    });
    return true;
  }

  // Verify token
  if (token !== config.secret) {
    sendJson(res, 401, { ok: false, error: "Invalid authentication token" });
    return true;
  }

  // Build history key
  const chatId = String(payload.chatId);
  const historyKey = buildTelegramGroupPeerId(chatId, payload.topicId);

  // Build sender label
  const senderLabel = buildSenderLabel(payload);

  // Build the history entry
  const entry: HistoryEntry = {
    sender: senderLabel,
    body: payload.text,
    timestamp: payload.timestamp * 1000, // Convert to milliseconds
    messageId: String(payload.messageId),
  };

  // Record to history (silent - no AI trigger)
  const entries = recordPendingHistoryEntryIfEnabled({
    historyMap,
    historyKey,
    entry,
    limit: config.historyLimit,
  });

  logVerbose(
    `telegram: external message recorded for ${historyKey}: ${senderLabel}: ${payload.text.slice(0, 50)}...`,
  );

  sendJson(res, 200, {
    ok: true,
    historyKey,
    entriesCount: entries.length,
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

  // Check for external messages config in telegram channel config
  const telegramConfig = cfg.channels?.telegram;
  if (!telegramConfig) {
    return null;
  }

  // Look for account-specific config first
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
