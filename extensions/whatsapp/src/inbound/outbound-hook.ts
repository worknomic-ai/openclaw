import type { WASocket } from "@whiskeysockets/baileys";

export interface WhatsAppOutboundContext {
  jid: string;
  accountId: string;
  isGroup: boolean;
  text: string;
  // Agent that authored this outbound. Populated when the outbound was
  // initiated by a runtime turn (cron / inbound-reply / tool); absent when
  // the send is a non-agent dispatch (e.g. pairing replies). The plugin
  // uses this to apply per-agent transforms — visually prefixing the
  // message with "▸ <displayName> ▸" so the user can tell agents apart in
  // a self-only group, self-DM, or public-group invocation reply
  // (designs/whatsapp.md §10.5, decision D7).
  agentId?: string;
  // Convenience mirror of identity.name from the openclaw outbound
  // context. The plugin can derive its prefix off this directly without
  // round-tripping the agent registry, since the renderer already
  // resolved the display name at delivery time.
  agentDisplayName?: string;
  // The inbound message id that triggered this turn, when applicable
  // (e.g. an agent reply in response to a user message). Lets the plugin
  // mark the inbound with a ✅ reaction once the outbound lands
  // (decision D5 + Task 3b).
  inboundTriggerMessageId?: string;
}

export interface WhatsAppOutboundResult {
  text?: string;
  afterSend?: (params: {
    jid: string;
    sock: WASocket;
    sentMessageId: string;
    inboundTriggerMessageId?: string;
  }) => void | Promise<void>;
}

export type WhatsAppOutboundHook = (
  ctx: WhatsAppOutboundContext,
) => WhatsAppOutboundResult | Promise<WhatsAppOutboundResult>;

// The hook lives behind a globalThis symbol so that bundlers which emit
// duplicate copies of this module across entry chunks (e.g. the plugin-sdk
// barrel and the whatsapp monitor chunk) still observe the same registered
// hook. Mirrors the pattern in connection-controller-registry.ts.
type OutboundHookState = { hook: WhatsAppOutboundHook | null };
const OUTBOUND_HOOK_KEY = Symbol.for("openclaw.whatsapp.outboundHookRegistry");

function getOutboundHookState(): OutboundHookState {
  const globalState = globalThis as typeof globalThis & {
    [OUTBOUND_HOOK_KEY]?: OutboundHookState;
  };
  const existing = globalState[OUTBOUND_HOOK_KEY];
  if (existing) {
    return existing;
  }
  const created: OutboundHookState = { hook: null };
  globalState[OUTBOUND_HOOK_KEY] = created;
  return created;
}

export function setWhatsAppOutboundHook(hook: WhatsAppOutboundHook | null): void {
  getOutboundHookState().hook = hook;
}

export function getWhatsAppOutboundHook(): WhatsAppOutboundHook | null {
  return getOutboundHookState().hook;
}
