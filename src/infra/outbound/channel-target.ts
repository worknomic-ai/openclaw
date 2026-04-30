import { getChannelPlugin } from "../../channels/plugins/registry.js";
import {
  hasNonEmptyString as sharedHasNonEmptyString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { MESSAGE_ACTION_TARGET_MODE } from "./message-action-spec.js";

export const hasNonEmptyString = sharedHasNonEmptyString;

// Identifiers only — never human-readable names. The previous "or name" phrasing
// nudged models to grab group_subject / contact display name from prompt
// metadata, which the per-channel target resolvers reject. Per-channel hints
// are appended via buildChannelTargetDescription() when a current channel is
// known so the model sees the exact accepted shape upfront.
export const CHANNEL_TARGET_DESCRIPTION =
  "Recipient identifier: E.164 for WhatsApp/Signal, Telegram chat id/@username, Discord/Slack channel/user id, iMessage handle/chat_id, or email address. Must be an exact identifier — display names, group subjects, and contact aliases are not accepted.";

export const CHANNEL_TARGETS_DESCRIPTION =
  "Recipient identifiers (same format as --target); display names and aliases are not accepted — use ids the channel's target resolver returned previously.";

/**
 * Build a target-field description scoped to a known channel. When a channel
 * plugin exposes a `messaging.targetResolver.hint`, embed it directly so the
 * model sees the accepted shape (e.g. `<E.164|group JID>`) before making a
 * call instead of discovering it via an `Unknown target` error after.
 */
export function buildChannelTargetDescription(channelId?: string): string {
  if (!channelId) return CHANNEL_TARGET_DESCRIPTION;
  const plugin = getChannelPlugin(channelId);
  const hint = plugin?.messaging?.targetResolver?.hint;
  if (!hint) return CHANNEL_TARGET_DESCRIPTION;
  return `Recipient identifier for ${channelId}: ${hint}. Must be an exact identifier — display names, group subjects, and contact aliases are not accepted.`;
}

export function applyTargetToParams(params: {
  action: string;
  args: Record<string, unknown>;
}): void {
  const target = normalizeOptionalString(params.args.target) ?? "";
  const hasLegacyTo = hasNonEmptyString(params.args.to);
  const hasLegacyChannelId = hasNonEmptyString(params.args.channelId);
  const mode =
    MESSAGE_ACTION_TARGET_MODE[params.action as keyof typeof MESSAGE_ACTION_TARGET_MODE] ?? "none";

  if (mode !== "none") {
    if (hasLegacyTo || hasLegacyChannelId) {
      throw new Error("Use `target` instead of `to`/`channelId`.");
    }
  } else if (hasLegacyTo) {
    throw new Error("Use `target` for actions that accept a destination.");
  }

  if (!target) {
    return;
  }
  if (mode === "channelId") {
    params.args.channelId = target;
    return;
  }
  if (mode === "to") {
    params.args.to = target;
    return;
  }
  throw new Error(`Action ${params.action} does not accept a target.`);
}
