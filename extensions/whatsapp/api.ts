export { whatsappPlugin } from "./src/channel.js";
export { whatsappSetupPlugin } from "./src/channel.setup.js";
export * from "./src/accounts.js";
export * from "./src/auto-reply/constants.js";
export { whatsappCommandPolicy } from "./src/command-policy.js";
export * from "./src/group-policy.js";
export { WHATSAPP_LEGACY_OUTBOUND_SEND_DEP_KEYS } from "./src/outbound-send-deps.js";
export * from "./src/text-runtime.js";
export type * from "./src/auto-reply/types.js";
export type * from "./src/inbound/types.js";
export {
  listWhatsAppDirectoryGroupsFromConfig,
  listWhatsAppDirectoryPeersFromConfig,
} from "./src/directory-config.js";
export { resolveWhatsAppOutboundTarget } from "./src/resolve-outbound-target.js";
export {
  isWhatsAppGroupJid,
  normalizeWhatsAppAllowFromEntries,
  isWhatsAppUserTarget,
  looksLikeWhatsAppTargetId,
  normalizeWhatsAppMessagingTarget,
  normalizeWhatsAppTarget,
  validateWhatsAppTargetShape,
} from "./src/normalize-target.js";
export {
  resolveWhatsAppGroupRequireMention,
  resolveWhatsAppGroupToolPolicy,
} from "./src/group-policy.js";
export { resolveWhatsAppGroupIntroHint } from "./src/runtime-api.js";
export { __testing as whatsappAccessControlTesting } from "./src/inbound/access-control.js";
// Plugin-facing runtime accessor: get the active WhatsApp listener for
// a given accountId. Returns null when no Baileys socket is currently
// connected for that account. Used by Clawsy to deliver A2UI card
// fallback text + drive per-agent self-only group creation on pair.
export { getActiveWebListener, resolveWebAccountId } from "./src/active-listener.js";
