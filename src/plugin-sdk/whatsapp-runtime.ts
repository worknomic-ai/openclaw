// Plugin-facing runtime accessors for the bundled WhatsApp extension.
//
// External plugins (e.g. Clawsy) cannot import from
// `@openclaw/whatsapp/api` directly because the bundled extension's
// package has no built dist artifact and its source pulls in
// extension-private dependencies. This file is the public seam: a
// thin re-export of the runtime functions external plugins need,
// compiled into the umbrella `openclaw` package's `dist/plugin-sdk/`
// alongside other plugin-sdk subpaths (conversation-runtime, etc.).
//
// Surfaces exposed:
//   - startWebLoginWithQr / waitForWebLogin  — drive the QR-pair flow
//   - getActiveWebListener / resolveWebAccountId — talk to the live
//     Baileys session for an accountId (sendMessage, groupCreate, …)
//   - ActiveWebListener type — for plugin-side type safety
//
// Used by Clawsy's per-agent self-only group flow (designs/whatsapp.md)
// + A2UI fallback delivery on the Baileys WhatsApp channel.

export {
  startWebLoginWithQr,
  waitForWebLogin,
} from "../../extensions/whatsapp/login-qr-runtime.js";

export {
  getActiveWebListener,
  resolveWebAccountId,
} from "../../extensions/whatsapp/src/active-listener.js";

export type {
  ActiveWebListener,
  ActiveWebSendOptions,
} from "../../extensions/whatsapp/src/inbound/types.js";

// Read the linked WhatsApp identity (E.164 + JID) from the on-disk
// creds for an accountId. Used by external plugins to surface the
// real linked number after pair — the listener doesn't expose it
// directly. Returns null fields when no creds exist or the file is
// malformed.

import type { OpenClawConfig } from "./config-runtime.js";
import { resolveWhatsAppAccount } from "../../extensions/whatsapp/src/accounts.js";
import { readWebSelfId } from "../../extensions/whatsapp/src/auth-store.js";

export interface WhatsAppSelfIdReadResult {
  e164: string | null;
  jid: string | null;
  lid: string | null;
}

export function readWhatsAppSelfIdForAccount(opts: {
  cfg: OpenClawConfig;
  accountId: string;
}): WhatsAppSelfIdReadResult {
  const account = resolveWhatsAppAccount({ cfg: opts.cfg, accountId: opts.accountId });
  const result = readWebSelfId(account.authDir);
  return {
    e164: result.e164 ?? null,
    jid: result.jid ?? null,
    lid: (result as { lid?: string | null }).lid ?? null,
  };
}
