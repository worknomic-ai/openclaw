// Plugin-registered runtime override for per-conversation WhatsApp
// inbound policy. Two knobs are exposed today:
//
//   - `requireMention`: governs the mention gate
//     (auto-reply/monitor/group-gating.ts: applyGroupGating mention check)
//   - `groupBlocked`: governs the allowlist gate that fires *earlier*
//     in the same path. When the resolver returns `groupBlocked: true`,
//     the allowlist gate behaves as if the group is not in the
//     allowlist — message is dropped before mention/auto-reply runs.
//     When `groupBlocked: false`, the gate is forced open even if the
//     rendered config would otherwise drop the message.
//
// Why this exists: per-conversation policy is durable in the rendered
// openclaw.json (channels.whatsapp.accounts.<id>.groups.<jid>.requireMention),
// but a slash command like /join /leave changes intent ahead of the
// rendered config catching up. Worse, the bundled WhatsApp channel
// declares `noopPrefixes: ["channels.whatsapp"]` — so reload-plan
// classifies group-map changes as no-op, and the running gateway never
// re-reads the new groups map. Without a runtime override, post-/leave
// the rendered config can show "group absent" forever while gating
// keeps using the start-time snapshot that still has the group entry.
//
// This seam fires on every inbound and consults plugin memory directly,
// sidestepping the no-op classification entirely.

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";

export interface WhatsAppConversationPolicyEvent {
  cfg: OpenClawConfig;
  accountId: string | null;
  // Resolved group JID (post `resolveGroupSessionKey`); plugin keys its
  // cache off this. For DMs this is the peer E.164.
  conversationId: string;
  // The value the rendered config would produce for this conversation.
  configRequireMention: boolean;
  // The allowlist decision the rendered config would produce for this
  // conversation. True = allowlist gate would let the message through
  // (group is in the configured groups map, or wildcard, or open).
  // False = allowlist gate would drop. Provided so the resolver can do
  // equality-based reconciliation against the cache.
  configAllowed: boolean;
}

export interface WhatsAppConversationPolicyResult {
  // When set, overrides the config-derived requireMention for this
  // conversation.
  requireMention?: boolean;
  // When `true`, overrides the allowlist gate decision to BLOCK (group
  // treated as not-in-allowlist regardless of rendered config). When
  // `false`, overrides the allowlist gate decision to ALLOW (group
  // treated as allowlisted regardless of rendered config). When
  // omitted, the inbound path falls back to the config-derived
  // allowlist decision.
  groupBlocked?: boolean;
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
