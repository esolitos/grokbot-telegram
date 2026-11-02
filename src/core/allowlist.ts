import type { Config } from "./config.js";

type AllowConfig = Pick<Config, "allowlistUserIds" | "allowlistChatIds" | "allowedChatTypes">;

/**
 * Id match only. A user id matches that person. A chat id matches that chat.
 * Group admission goes through `isChatAdmitted`, which also requires the chat type.
 */
export function isAllowlisted(
  userId: string | null,
  chatId: string | null,
  config: Pick<Config, "allowlistUserIds" | "allowlistChatIds">,
): boolean {
  if (config.allowlistUserIds.size === 0 && config.allowlistChatIds.size === 0) return false;
  if (userId && config.allowlistUserIds.has(userId)) return true;
  if (chatId && config.allowlistChatIds.has(chatId)) return true;
  return false;
}

/**
 * Private chats follow the allowlist. Groups and supergroups are admitted only
 * when that type is enabled and the chat id itself is listed. A user id never
 * opens a group, so a reply in someone else's group cannot wake the bot.
 */
export function isChatAdmitted(
  userId: string | null,
  chatId: string | null,
  chatType: string,
  config: AllowConfig,
): boolean {
  if (!config.allowedChatTypes.has(chatType)) return false;
  if (chatType === "private") return isAllowlisted(userId, chatId, config);
  if ((chatType === "group" || chatType === "supergroup") && chatId) {
    return config.allowlistChatIds.has(chatId);
  }
  return false;
}

/**
 * Supergroup and channel ids are `-100` followed by a 10-digit id, so the
 * whole value is <= -1000000000000. A shorter negative id such as -100500 is
 * a basic group. Positive ids are private chats.
 */
export function chatTypeFromId(chatId: string): "private" | "group" | "supergroup" {
  if (!chatId.startsWith("-")) return "private";
  const value = Number(chatId);
  if (!Number.isSafeInteger(value)) return "group";
  return value <= -1_000_000_000_000 ? "supergroup" : "group";
}

/**
 * Proactive sends have no end-user attached. A private chat is allowed when
 * its id is listed or it is an allowlisted user's DM (Telegram uses the same
 * id for both). A group is allowed only when that type is enabled and the
 * chat id is listed.
 */
export function isOutboundChatAllowed(chatId: string, config: AllowConfig): boolean {
  if (config.allowlistUserIds.size === 0 && config.allowlistChatIds.size === 0) return false;
  const chatType = chatTypeFromId(chatId);
  if (!config.allowedChatTypes.has(chatType)) return false;
  if (chatType === "private") {
    return config.allowlistChatIds.has(chatId) || config.allowlistUserIds.has(chatId);
  }
  return config.allowlistChatIds.has(chatId);
}
