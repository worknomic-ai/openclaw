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
  startWebLoginWithPairingCode,
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

export { setWhatsAppOutboundHook } from "../../extensions/whatsapp/src/inbound/outbound-hook.js";
export type {
  WhatsAppOutboundHook,
  WhatsAppOutboundContext,
  WhatsAppOutboundResult,
} from "../../extensions/whatsapp/src/inbound/outbound-hook.js";

// Read the linked WhatsApp identity (E.164 + JID) from the on-disk
// creds for an accountId. Used by external plugins to surface the
// real linked number after pair — the listener doesn't expose it
// directly. Returns null fields when no creds exist or the file is
// malformed.

import { resolveWhatsAppAccount } from "../../extensions/whatsapp/src/accounts.js";
import { readWebSelfId } from "../../extensions/whatsapp/src/auth-store.js";
import type { OpenClawConfig } from "./config-runtime.js";

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

import { closeWaSocket } from "../../extensions/whatsapp/src/connection-controller.js";
// Create a self-only WhatsApp group via a fresh, ephemeral Baileys
// socket using the auth state currently on disk for `accountId`.
// Designed for the brief window after QR pair completes but BEFORE
// the gateway has loaded the persistent monitorWebChannel socket
// (which only happens after the connection's status flips to active
// and the config-sync triggers a plugin-load gateway restart). The
// alternative — calling groupCreate via getActiveWebListener — fails
// in that window because the login socket has already been closed
// and the persistent monitor socket hasn't started yet.
//
// Returns null on transport failure / timeout. Empty `participants`
// is intentional: modern WhatsApp accepts self-only groups, which is
// the per-agent thread model Clawsy uses (designs/whatsapp.md §4).
import { createWaSocket, waitForWaConnection } from "../../extensions/whatsapp/src/session.js";
import { getChildLogger } from "./runtime-env.js";

// Render a solid-color 640×640 JPEG buffer for use as a WhatsApp group
// avatar. WhatsApp's updateProfilePicture is markedly more reliable on
// JPEGs sourced from a higher-resolution input (the server resamples
// before storing); a 192×192 PNG silently fails for many accounts.
async function renderSolidColorAvatarJpeg(hexColor: string): Promise<Buffer> {
  const { Jimp } = await import("jimp");
  const cleaned = hexColor.replace(/^#/, "");
  const r = parseInt(cleaned.slice(0, 2), 16);
  const g = parseInt(cleaned.slice(2, 4), 16);
  const b = parseInt(cleaned.slice(4, 6), 16);
  const rgba = (r << 24) | (g << 16) | (b << 8) | 0xff;
  const img = new Jimp({ width: 640, height: 640, color: rgba >>> 0 });
  return await img.getBuffer("image/jpeg", { quality: 85 });
}

// Hash a string to one of N palette colors. Stable per agent so the
// same agent always gets the same color. Palette chosen for distinct
// hues at WhatsApp's small display size.
const AVATAR_PALETTE = [
  "#fbbf24", // amber
  "#3b82f6", // blue
  "#10b981", // emerald
  "#ec4899", // pink
  "#8b5cf6", // violet
  "#f97316", // orange
  "#14b8a6", // teal
  "#f43f5e", // rose
];
function colorForAgent(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % AVATAR_PALETTE.length;
  return AVATAR_PALETTE[idx]!;
}

export async function createWhatsAppSelfOnlyGroupViaFreshSocket(opts: {
  cfg: OpenClawConfig;
  accountId: string;
  subject: string;
  // Post-create customization. Both optional; if omitted the helper
  // just creates the group like before. Done in the SAME socket
  // session as groupCreate so we don't pay for two round-trips.
  welcomeText?: string;
  // Seed for the avatar color hash. Typically the agent's name so
  // re-running customization for the same agent yields the same color.
  avatarSeed?: string;
  timeoutMs?: number;
}): Promise<{ jid: string } | null> {
  const account = resolveWhatsAppAccount({ cfg: opts.cfg, accountId: opts.accountId });
  const sock = await createWaSocket(false, false, { authDir: account.authDir });
  const timeoutMs = opts.timeoutMs ?? 30_000;
  let timer: NodeJS.Timeout | undefined;
  try {
    const connected = Promise.race([
      waitForWaConnection(sock),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("groupCreate-socket: connection timeout")),
          timeoutMs,
        );
      }),
    ]);
    await connected;
    if (timer) clearTimeout(timer);

    const result = await (
      sock as unknown as {
        groupCreate: (subject: string, participants: string[]) => Promise<{ id: string }>;
      }
    ).groupCreate(opts.subject, []);
    const jid = result.id;

    // Post-create customization: avatar + welcome message. These are
    // best-effort — a failure here doesn't roll back the group create
    // (the user has a usable group, just without flair).
    if (opts.avatarSeed) {
      try {
        const jpeg = await renderSolidColorAvatarJpeg(colorForAgent(opts.avatarSeed));
        await (
          sock as unknown as {
            updateProfilePicture: (jid: string, content: Buffer) => Promise<void>;
          }
        ).updateProfilePicture(jid, jpeg);
      } catch (err) {
        getChildLogger({ module: "wa-self-only-group" }).warn(
          { err: err instanceof Error ? err.message : String(err), jid },
          "updateProfilePicture failed",
        );
      }
    }
    if (opts.welcomeText) {
      try {
        await (
          sock as unknown as {
            sendMessage: (jid: string, content: { text: string }) => Promise<unknown>;
          }
        ).sendMessage(jid, { text: opts.welcomeText });
      } catch {
        // best-effort
      }
    }
    return { jid };
  } catch {
    if (timer) clearTimeout(timer);
    return null;
  } finally {
    try {
      closeWaSocket(sock);
    } catch {
      // best-effort
    }
  }
}
