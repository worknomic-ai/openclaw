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
