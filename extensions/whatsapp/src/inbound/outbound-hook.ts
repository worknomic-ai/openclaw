import type { WASocket } from "@whiskeysockets/baileys";

export interface WhatsAppOutboundContext {
  jid: string;
  accountId: string;
  isGroup: boolean;
  text: string;
}

export interface WhatsAppOutboundResult {
  text?: string;
  afterSend?: (params: {
    jid: string;
    sock: WASocket;
    sentMessageId: string;
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
