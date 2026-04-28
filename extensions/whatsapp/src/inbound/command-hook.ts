// Pre-gating command hook for plugins layered on top of the WhatsApp
// extension. Fires from the inbound monitor BEFORE access-control runs,
// giving plugins a chance to recognize and short-circuit lifecycle /
// control commands without burning an LLM turn.
//
// The existing `dispatched` event (./inbound-event-hook.ts) fires
// AFTER every gate has passed and the agent is already about to engage
// — too late to suppress the agent. This hook fires earlier so a
// plugin's command handler can:
//
//   1. Decide if the message is addressed to the agent (channel-side
//      mention rules — `@<displayName>` etc.)
//   2. Recognize a command-shaped body (e.g. `/<verb>`)
//   3. Authorize the sender (e.g. owner-only)
//   4. Execute the command + send a reply via the supplied sock
//   5. Return `{ handled: true }` so the monitor drops the message
//      from openclaw's pipeline (no access-control, no mention-detect,
//      no LLM turn).
//
// Returning `{ handled: false }` (or omitting the hook) restores the
// previous default flow.

import type { proto, AnyMessageContent } from "@whiskeysockets/baileys";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";

export interface WhatsAppCommandEvent {
  cfg: OpenClawConfig;
  accountId: string;
  // Raw remote JID (`<digits>@s.whatsapp.net` for DMs, `<id>@g.us` for groups).
  remoteJid: string;
  // Group sender JID (only present for group messages).
  participantJid?: string;
  // Conversation peer's E.164 (DMs) or the group JID itself (groups) —
  // matches what monitor.normalizeInboundMessage feeds to access-control.
  from: string;
  // Resolved E.164 of the human who actually typed the message.
  // For DMs this equals `from`. For groups it's the participant's E.164.
  // Null when resolution fails (rare; LID-only groups during initial sync).
  senderE164: string | null;
  // The owner/account self number (paired Baileys session).
  selfE164: string | null;
  isGroup: boolean;
  // True when the linked-device session itself authored the message.
  // Owner sending from any of THEIR devices flips this true.
  isFromMe: boolean;
  // Sender display name as advertised by WhatsApp; useful for fallback ID
  // when senderE164 resolution failed.
  pushName?: string;
  // Raw Baileys message — plugins can extract body / media / quote
  // context themselves rather than the seam pre-extracting and forcing
  // a fixed shape.
  msg: proto.IWebMessageInfo;
  // Tracked-send sock surface — plugin replies through this so the
  // gateway's outbound de-dup ledger sees the message and the
  // dispatched/inbound-echo paths skip it correctly.
  sock: {
    sendMessage: (jid: string, content: AnyMessageContent) => Promise<unknown>;
  };
}

export interface WhatsAppCommandHookResult {
  handled: boolean;
}

export type WhatsAppCommandHook = (
  event: WhatsAppCommandEvent,
) => Promise<WhatsAppCommandHookResult> | WhatsAppCommandHookResult;

// Stored behind a globalThis symbol — bundlers may emit duplicate
// copies of this module across entry chunks; the symbol-keyed registry
// keeps a single source of truth regardless. Same shape as the existing
// outbound + inbound-event hooks in this directory.
type CommandHookState = { hook: WhatsAppCommandHook | null };
const COMMAND_HOOK_KEY = Symbol.for("openclaw.whatsapp.commandHookRegistry");

function getCommandHookState(): CommandHookState {
  const globalState = globalThis as typeof globalThis & {
    [COMMAND_HOOK_KEY]?: CommandHookState;
  };
  const existing = globalState[COMMAND_HOOK_KEY];
  if (existing) {
    return existing;
  }
  const created: CommandHookState = { hook: null };
  globalState[COMMAND_HOOK_KEY] = created;
  return created;
}

export function setWhatsAppCommandHook(hook: WhatsAppCommandHook | null): void {
  getCommandHookState().hook = hook;
}

export function getWhatsAppCommandHook(): WhatsAppCommandHook | null {
  return getCommandHookState().hook;
}
