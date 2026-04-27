import type { WASocket } from "@whiskeysockets/baileys";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import type { OpenClawConfig } from "../runtime-api.js";

// Settle window after `connection: "open"` before we touch group state.
// Empirically the `noise-handler` finishes the post-handshake setup within
// ~1-2s; we wait a bit longer so groupMetadata IQs aren't racing against
// `chats.upsert` / app-state hydration that runs immediately on connect.
const SETTLE_DELAY_MS = 2_500;
const PRESENCE_DELAY_MS = 250;

/**
 * Force the user's primary phone to redistribute its sender-key for the given
 * groups whenever this Baileys session re-establishes a connection.
 *
 * Background: each WhatsApp group conversation uses the Signal Sender Key
 * protocol (one-to-many). The primary phone tracks "which devices have my
 * current sender key" in its own state; when our linked-device session
 * restarts, the primary's cache is unaware and continues encrypting with
 * the assumption we still have the key. Inbound `skmsg` payloads then fail
 * to decrypt on our side and Baileys' retry-receipt path is unreliable for
 * recovering the chain when the gateway bounces (the user's phone may have
 * pruned us from its `senderKeyMap` between sessions, or may simply not act
 * on retry receipts within the window we need).
 *
 * Baileys 7.0.0-rc.9 has no public API to make a peer device re-emit an
 * SKDM. The protocol-level mechanisms that exist are all reactive (retry
 * receipts on undecryptable messages). What we *can* do is make our side
 * of the chain healthy and nudge the WhatsApp server to revalidate our
 * participation, which in practice prompts the primary's encryption pipeline
 * to rebuild its participant device list and re-emit SKDMs:
 *
 *  1. Wipe our local `sender-key-memory[<groupJid>]` so the next outbound
 *     message we send into that group bundles a fresh SKDM to every
 *     participant device (matches the same wipe Baileys performs on retry
 *     in `messages-recv.js`, lib/Socket/messages-recv.js:810).
 *  2. Refresh group metadata via `groupMetadata(jid)` — this issues a
 *     `<iq type="get" xmlns="w:g2"><query .../></iq>` that nudges the WA
 *     server-side participant list cache.
 *  3. Subscribe to group presence — `presenceSubscribe(jid)` — which signals
 *     to WA that this device is actively participating, often the trigger
 *     that causes the primary to revalidate sender keys.
 *
 * All steps are best-effort; we swallow per-jid failures and continue.
 */
export type SenderKeyResyncDeps = {
  sock: Pick<WASocket, "authState" | "groupMetadata" | "presenceSubscribe">;
  groupJids: readonly string[];
  verbose: boolean;
  delayMs?: number;
  abortSignal?: AbortSignal;
};

const inboundConsoleLog = createSubsystemLogger("gateway/channels/whatsapp").child(
  "sender-key-resync",
);

function logVerbose(enabled: boolean, message: string): void {
  if (!enabled) {
    return;
  }
  defaultRuntime.log(message);
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === "AbortError") {
    return true;
  }
  return false;
}

function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function clearSenderKeyMemory(
  authState: WASocket["authState"],
  groupJid: string,
): Promise<void> {
  // `sender-key-memory` is a per-group map of `{ [participantJid]: boolean }`
  // tracking which device we've already SKDM'd to. Setting the whole entry to
  // `null` deletes it and forces `messages-send.ts` to re-bundle SKDMs to
  // every participant on our next outbound to this group. This is the same
  // shape Baileys writes from `handleRetryReceipt` (lib/Socket/messages-recv.js:810).
  await authState.keys.set({ "sender-key-memory": { [groupJid]: null } });
}

async function resyncSingleGroup(
  deps: SenderKeyResyncDeps,
  groupJid: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await clearSenderKeyMemory(deps.sock.authState, groupJid);
  } catch (err) {
    return { ok: false, error: `clear sender-key-memory: ${String(err)}` };
  }

  try {
    await deps.sock.groupMetadata(groupJid);
  } catch (err) {
    // groupMetadata throws if we're no longer a participant; that's expected
    // for groups the user removed us from. Log and continue.
    return { ok: false, error: `groupMetadata: ${String(err)}` };
  }

  try {
    // Presence subscribe is fire-and-forget on the wire; small spacing avoids
    // hammering the server when many groups are being resynced at once.
    await delayWithAbort(PRESENCE_DELAY_MS, deps.abortSignal);
    await deps.sock.presenceSubscribe(groupJid);
  } catch (err) {
    if (isAbortError(err)) {
      throw err;
    }
    return { ok: false, error: `presenceSubscribe: ${String(err)}` };
  }

  return { ok: true };
}

export async function runSenderKeyResyncOnConnect(deps: SenderKeyResyncDeps): Promise<void> {
  const groups = Array.from(new Set(deps.groupJids.filter((jid) => jid.endsWith("@g.us"))));
  if (groups.length === 0) {
    return;
  }

  try {
    await delayWithAbort(deps.delayMs ?? SETTLE_DELAY_MS, deps.abortSignal);
  } catch (err) {
    if (isAbortError(err)) {
      return;
    }
    throw err;
  }

  let succeeded = 0;
  const failures: Array<{ jid: string; error: string }> = [];

  for (const jid of groups) {
    if (deps.abortSignal?.aborted) {
      return;
    }
    try {
      const result = await resyncSingleGroup(deps, jid);
      if (result.ok) {
        succeeded += 1;
      } else if (result.error) {
        failures.push({ jid, error: result.error });
      }
    } catch (err) {
      if (isAbortError(err)) {
        return;
      }
      failures.push({ jid, error: String(err) });
    }
  }

  if (succeeded > 0) {
    logVerbose(
      deps.verbose,
      `Sender-key resync touched ${succeeded}/${groups.length} self-only groups on connect`,
    );
  }
  if (failures.length > 0) {
    inboundConsoleLog.warn(
      `Sender-key resync had ${failures.length} failure(s): ${failures
        .slice(0, 3)
        .map((f) => `${f.jid}: ${f.error}`)
        .join("; ")}${failures.length > 3 ? " (truncated)" : ""}`,
    );
    logVerbose(
      deps.verbose,
      `Sender-key resync failures: ${failures.map((f) => `${f.jid}: ${f.error}`).join("; ")}`,
    );
  }
}

export function collectSelfOnlyGroupJidsFromConfig(
  cfg: OpenClawConfig,
  accountId: string,
): string[] {
  const accounts = cfg.channels?.whatsapp?.accounts;
  const account =
    accounts && typeof accounts === "object"
      ? (accounts as Record<string, unknown>)[accountId]
      : undefined;
  if (!account || typeof account !== "object") {
    return [];
  }
  const collected = new Set<string>();
  // `groups` is an explicit per-group config map keyed by group JID — the
  // canonical source for self-only-group identity in Clawsy's emitted config.
  const groups = (account as { groups?: Record<string, unknown> }).groups;
  if (groups && typeof groups === "object") {
    for (const key of Object.keys(groups)) {
      if (key.endsWith("@g.us")) {
        collected.add(key);
      }
    }
  }
  // `groupAllowFrom` mirrors the same JIDs in Clawsy's emitter; include any
  // group-shaped entries here too as a defensive backstop in case the two
  // drift (`groupAllowFrom` may legitimately also hold E.164 senders for
  // non-self-only deployments — we filter on `@g.us` to stay safe).
  const groupAllowFrom = (account as { groupAllowFrom?: unknown }).groupAllowFrom;
  if (Array.isArray(groupAllowFrom)) {
    for (const entry of groupAllowFrom) {
      if (typeof entry === "string" && entry.endsWith("@g.us")) {
        collected.add(entry);
      }
    }
  }
  return Array.from(collected);
}
