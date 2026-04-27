// Lifecycle event the inbound monitor fires for plugins layered on top of
// the WhatsApp extension.
//
// Single event today:
//
//   - "dispatched": fires once a received message has cleared every gate
//     (echo, system-jid filter, fromMe self-echo, access-control —
//     dmPolicy / pairing / groupPolicy — and group mention-gating /
//     activation) AND is about to be handed to the agent. Plugins can
//     react to it knowing the agent is going to engage with the message
//     (e.g. add a 👀 reaction). The corresponding "✅ on reply complete"
//     half is already wired through the outbound hook's
//     inboundTriggerMessageId path, so plugins don't need a paired
//     "no-reply" event here.
//
// Why a single dispatch event instead of received/dropped: the previous
// shape ("received" on every inbound, "dropped" on access-control reject)
// made the user see UI side-effects (e.g. a flashing 👀) on every WhatsApp
// message — including 3rd-party DMs and unmentioned group messages the
// agent never engages with. Mention-gating runs deeper than access-control
// (in auto-reply/monitor) so received/dropped couldn't model the real
// dispatch decision without coupling the two layers. Firing "dispatched"
// from the actual dispatch path keeps the contract tight.

export interface WhatsAppInboundEvent {
  kind: "dispatched";
  accountId: string;
  remoteJid: string;
  messageId: string;
  // Group-chat participant JID (sender). Undefined for direct chats.
  participantJid?: string;
  // True for group remoteJids (suffix @g.us).
  isGroup: boolean;
}

export type WhatsAppInboundEventHook = (event: WhatsAppInboundEvent) => void | Promise<void>;

// Stored behind a globalThis symbol for the same reason as the outbound
// hook (see ./outbound-hook.ts) — bundlers may emit duplicate copies of
// this module across entry chunks.
type InboundHookState = { hook: WhatsAppInboundEventHook | null };
const INBOUND_HOOK_KEY = Symbol.for("openclaw.whatsapp.inboundEventHookRegistry");

function getInboundHookState(): InboundHookState {
  const globalState = globalThis as typeof globalThis & {
    [INBOUND_HOOK_KEY]?: InboundHookState;
  };
  const existing = globalState[INBOUND_HOOK_KEY];
  if (existing) {
    return existing;
  }
  const created: InboundHookState = { hook: null };
  globalState[INBOUND_HOOK_KEY] = created;
  return created;
}

export function setWhatsAppInboundEventHook(hook: WhatsAppInboundEventHook | null): void {
  getInboundHookState().hook = hook;
}

export function getWhatsAppInboundEventHook(): WhatsAppInboundEventHook | null {
  return getInboundHookState().hook;
}
