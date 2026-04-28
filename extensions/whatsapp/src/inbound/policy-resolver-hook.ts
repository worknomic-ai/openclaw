// Plugin-registered runtime override for per-conversation WhatsApp
// inbound policy. Today the only knob exposed is `requireMention`
// (group activation: "always" vs "mention"); the shape is open so we
// can extend without churning the contract.
//
// Why this exists: per-conversation policy is durable in the rendered
// openclaw.json (channels.whatsapp.accounts.<id>.groups.<jid>.requireMention),
// but a slash command like /join changes intent ahead of the renderer
// catching up — provisioner DB write → /vm/config poll (~20s) → file
// rewrite → chokidar reload. That gap used to drop messages or force a
// gateway restart.
//
// With this seam, the plugin holds an in-memory cache of recent
// command-driven policy changes and overrides on the inbound hot path.
// The cache self-evicts when the rendered config catches up (resolver
// sees `configRequireMention` matches its cached value → drops the
// entry, returns undefined, falls through to config).

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";

export interface WhatsAppConversationPolicyEvent {
  cfg: OpenClawConfig;
  accountId: string | null;
  // Resolved group JID (post `resolveGroupSessionKey`); plugin keys its
  // cache off this. For DMs this is the peer E.164.
  conversationId: string;
  // The value the rendered config would produce for this conversation.
  // Provided so the resolver can do equality-based self-eviction
  // without reaching back into the same resolver helpers.
  configRequireMention: boolean;
}

export interface WhatsAppConversationPolicyResult {
  // When set, overrides the config-derived requireMention for this
  // conversation. When omitted/undefined, the inbound path falls back
  // to the config-derived value.
  requireMention?: boolean;
}

export type WhatsAppConversationPolicyResolver = (
  event: WhatsAppConversationPolicyEvent,
) => WhatsAppConversationPolicyResult | undefined;

// Single-slot global registry, mirroring command-hook.ts. Bundlers may
// emit duplicate copies of this module across entry chunks; the
// symbol-keyed registry keeps a single source of truth regardless.
type ResolverState = { resolver: WhatsAppConversationPolicyResolver | null };
const RESOLVER_KEY = Symbol.for("openclaw.whatsapp.conversationPolicyResolverRegistry");

function getResolverState(): ResolverState {
  const globalState = globalThis as typeof globalThis & {
    [RESOLVER_KEY]?: ResolverState;
  };
  const existing = globalState[RESOLVER_KEY];
  if (existing) {
    return existing;
  }
  const created: ResolverState = { resolver: null };
  globalState[RESOLVER_KEY] = created;
  return created;
}

export function setWhatsAppConversationPolicyResolver(
  resolver: WhatsAppConversationPolicyResolver | null,
): void {
  getResolverState().resolver = resolver;
}

export function getWhatsAppConversationPolicyResolver(): WhatsAppConversationPolicyResolver | null {
  return getResolverState().resolver;
}
