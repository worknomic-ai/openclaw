import type {
  AnyMessageContent,
  MiscMessageGenerationOptions,
  proto,
  WAMessage,
  WASocket,
} from "@whiskeysockets/baileys";
import { formatLocationText } from "openclaw/plugin-sdk/channel-inbound";
import { createInboundDebouncer } from "openclaw/plugin-sdk/channel-inbound-debounce";
import { recordChannelActivity } from "openclaw/plugin-sdk/infra-runtime";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { getChildLogger } from "openclaw/plugin-sdk/text-runtime";
import { readWebSelfIdentityForDecision, WhatsAppAuthUnstableError } from "../auth-store.js";
import { getPrimaryIdentityId, resolveComparableIdentity } from "../identity.js";
import { cacheInboundMessageMeta } from "../quoted-message.js";
import { DEFAULT_RECONNECT_POLICY, computeBackoff, sleepWithAbort } from "../reconnect.js";
import type { OpenClawConfig } from "../runtime-api.js";
import { createWaSocket, formatError, getStatusCode, waitForWaConnection } from "../session.js";
import { resolveJidToE164 } from "../text-runtime.js";
import { checkInboundAccessControl } from "./access-control.js";
import {
  claimRecentInboundMessage,
  commitRecentInboundMessage,
  isRecentOutboundMessage,
  releaseRecentInboundMessage,
  rememberRecentOutboundMessage,
  WhatsAppRetryableInboundError,
} from "./dedupe.js";
import {
  describeReplyContext,
  extractLocationData,
  extractContactContext,
  extractMediaPlaceholder,
  extractMentionedJids,
  extractText,
} from "./extract.js";
import { attachEmitterListener, closeInboundMonitorSocket } from "./lifecycle.js";
import { downloadInboundMedia } from "./media.js";
import { getWhatsAppOutboundHook } from "./outbound-hook.js";
import { DisconnectReason, isJidGroup, saveMediaBuffer } from "./runtime-api.js";
import { createWebSendApi } from "./send-api.js";
import {
  collectSelfOnlyGroupJidsFromConfig,
  runSenderKeyResyncOnConnect,
} from "./sender-key-resync.js";
import type { WebInboundMessage, WebListenerCloseReason } from "./types.js";

const LOGGED_OUT_STATUS = DisconnectReason?.loggedOut ?? 401;
const RECONNECT_IN_PROGRESS_ERROR = "no active socket - reconnection in progress";

function logWhatsAppVerbose(enabled: boolean | undefined, message: string) {
  if (!enabled) {
    return;
  }
  defaultRuntime.log(message);
}

function isGroupJid(jid: string): boolean {
  return (typeof isJidGroup === "function" ? isJidGroup(jid) : jid.endsWith("@g.us")) === true;
}

function isRetryableSendDisconnectError(err: unknown): boolean {
  return /closed|reset|timed\s*out|disconnect|no active socket/i.test(formatError(err));
}

function shouldClearSocketRefAfterSendFailure(err: unknown): boolean {
  return /closed|reset|disconnect|no active socket/i.test(formatError(err));
}

function isNonEmptyString(value: string | undefined): value is string {
  return Boolean(value);
}

export type MonitorWebInboxOptions = {
  cfg: OpenClawConfig;
  verbose: boolean;
  accountId: string;
  authDir: string;
  onMessage: (msg: WebInboundMessage) => Promise<void>;
  mediaMaxMb?: number;
  /** Keep the global presence unavailable so self-chat sessions do not mute phone pushes. */
  selfChatMode?: boolean;
  /** Send read receipts for incoming messages (default true). */
  sendReadReceipts?: boolean;
  /** Debounce window (ms) for batching rapid consecutive messages from the same sender (0 to disable). */
  debounceMs?: number;
  /** Optional debounce gating predicate. */
  shouldDebounce?: (msg: WebInboundMessage) => boolean;
  /** Optional shared socket reference so reply closures can follow reconnects. */
  socketRef?: { current: WASocket | null };
  /** Whether send retries should wait for a reconnect. */
  shouldRetryDisconnect?: () => boolean;
  /** Reconnect timing for waiting through transient socket replacement gaps. */
  disconnectRetryPolicy?: {
    initialMs: number;
    maxMs: number;
    factor: number;
    jitter: number;
    maxAttempts: number;
  };
  /** Abort in-flight reconnect waits when shutdown becomes terminal. */
  disconnectRetryAbortSignal?: AbortSignal;
};

export async function attachWebInboxToSocket(
  options: MonitorWebInboxOptions & {
    sock: WASocket;
  },
) {
  const inboundLogger = getChildLogger({ module: "web-inbound" });
  const inboundConsoleLog = createSubsystemLogger("gateway/channels/whatsapp").child("inbound");
  const sock = options.sock;
  const connectedAtMs = Date.now();
  if (options.socketRef) {
    options.socketRef.current = sock;
  }
  const getCurrentSock = () => (options.socketRef ? options.socketRef.current : sock);
  const shouldRetryDisconnect = () => options.shouldRetryDisconnect?.() === true;
  const disconnectRetryPolicy = options.disconnectRetryPolicy ?? DEFAULT_RECONNECT_POLICY;
  const sendRetryMaxAttempts =
    disconnectRetryPolicy.maxAttempts > 0
      ? disconnectRetryPolicy.maxAttempts
      : DEFAULT_RECONNECT_POLICY.maxAttempts;

  let onCloseResolve: ((reason: WebListenerCloseReason) => void) | null = null;
  const onClose = new Promise<WebListenerCloseReason>((resolve) => {
    onCloseResolve = resolve;
  });
  const resolveClose = (reason: WebListenerCloseReason) => {
    if (!onCloseResolve) {
      return;
    }
    const resolver = onCloseResolve;
    onCloseResolve = null;
    resolver(reason);
  };
  const presence = options.selfChatMode ? "unavailable" : "available";

  try {
    await sock.sendPresenceUpdate(presence);
    logWhatsAppVerbose(options.verbose, `Sent global '${presence}' presence on connect`);
  } catch (err) {
    logWhatsAppVerbose(
      options.verbose,
      `Failed to send '${presence}' presence on connect: ${String(err)}`,
    );
  }

  const selfIdentity = await readWebSelfIdentityForDecision(
    options.authDir,
    sock.user as { id?: string | null; lid?: string | null } | undefined,
  );
  if (selfIdentity.outcome === "unstable") {
    throw new WhatsAppAuthUnstableError(
      "WhatsApp auth state is still stabilizing; retrying inbox attach.",
    );
  }
  const self = selfIdentity.identity;
  type QueuedInboundMessage = WebInboundMessage & {
    dedupeKey?: string;
  };

  const finalizeInboundDedupe = async (
    entries: QueuedInboundMessage[],
    error?: unknown,
  ): Promise<void> => {
    const dedupeKeys = [
      ...new Set(entries.map((entry) => entry.dedupeKey).filter(isNonEmptyString)),
    ];
    if (dedupeKeys.length === 0) {
      return;
    }
    if (error instanceof WhatsAppRetryableInboundError) {
      dedupeKeys.forEach((dedupeKey) => releaseRecentInboundMessage(dedupeKey, error));
      return;
    }
    await Promise.all(dedupeKeys.map((dedupeKey) => commitRecentInboundMessage(dedupeKey)));
  };

  const debouncer = createInboundDebouncer<QueuedInboundMessage>({
    debounceMs: options.debounceMs ?? 0,
    buildKey: (msg) => {
      const sender = msg.sender;
      const senderKey =
        msg.chatType === "group"
          ? (getPrimaryIdentityId(sender ?? null) ??
            msg.senderJid ??
            msg.senderE164 ??
            msg.senderName ??
            msg.from)
          : msg.from;
      if (!senderKey) {
        return null;
      }
      const conversationKey = msg.chatType === "group" ? msg.chatId : msg.from;
      return `${msg.accountId}:${conversationKey}:${senderKey}`;
    },
    shouldDebounce: options.shouldDebounce,
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      try {
        if (entries.length === 1) {
          await options.onMessage(last);
          await finalizeInboundDedupe(entries);
          return;
        }
        const mentioned = new Set<string>();
        for (const entry of entries) {
          for (const jid of entry.mentions ?? entry.mentionedJids ?? []) {
            mentioned.add(jid);
          }
        }
        const combinedBody = entries
          .map((entry) => entry.body)
          .filter(Boolean)
          .join("\n");
        const combinedMessage: WebInboundMessage = {
          ...last,
          body: combinedBody,
          mentions: mentioned.size > 0 ? Array.from(mentioned) : undefined,
          mentionedJids: mentioned.size > 0 ? Array.from(mentioned) : undefined,
          isBatched: true,
        };
        await options.onMessage(combinedMessage);
        await finalizeInboundDedupe(entries);
      } catch (error) {
        await finalizeInboundDedupe(entries, error);
        throw error;
      }
    },
    onError: (err) => {
      inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
      inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
    },
  });
  const groupMetaCache = new Map<
    string,
    { subject?: string; participants?: string[]; expires: number }
  >();
  const GROUP_META_TTL_MS = 5 * 60 * 1000; // 5 minutes
  const lidLookup = sock.signalRepository?.lidMapping;

  const resolveInboundJid = async (jid: string | null | undefined): Promise<string | null> =>
    resolveJidToE164(jid, { authDir: options.authDir, lidLookup });

  const rememberOutboundMessage = (remoteJid: string, result: unknown) => {
    const messageId =
      typeof result === "object" && result && "key" in result
        ? ((result as { key?: { id?: string } }).key?.id ?? "")
        : "";
    if (!messageId) {
      return;
    }
    rememberRecentOutboundMessage({
      accountId: options.accountId,
      remoteJid,
      messageId,
    });
  };

  const sendTrackedMessage = async (
    jid: string,
    content: AnyMessageContent,
    sendOptions?: MiscMessageGenerationOptions,
  ) => {
    let lastErr: unknown = new Error(RECONNECT_IN_PROGRESS_ERROR);
    for (let attempt = 1; ; attempt++) {
      const currentSock = getCurrentSock();
      if (currentSock) {
        try {
          const result = sendOptions
            ? await currentSock.sendMessage(jid, content, sendOptions)
            : await currentSock.sendMessage(jid, content);
          rememberOutboundMessage(jid, result);
          return result;
        } catch (err) {
          if (!shouldRetryDisconnect() || !isRetryableSendDisconnectError(err)) {
            throw err;
          }
          lastErr = err;
          if (
            shouldClearSocketRefAfterSendFailure(err) &&
            options.socketRef?.current === currentSock
          ) {
            options.socketRef.current = null;
          }
        }
      } else if (!shouldRetryDisconnect()) {
        throw lastErr;
      }

      if (attempt >= sendRetryMaxAttempts) {
        throw lastErr;
      }
      const delayMs = computeBackoff(disconnectRetryPolicy, attempt);
      logWhatsAppVerbose(
        options.verbose,
        `Waiting ${delayMs}ms for WhatsApp reconnect before retrying send to ${jid}: ${formatError(lastErr)}`,
      );
      try {
        await sleepWithAbort(delayMs, options.disconnectRetryAbortSignal);
      } catch {
        throw lastErr;
      }
    }
  };

  const getGroupMeta = async (jid: string) => {
    const cached = groupMetaCache.get(jid);
    if (cached && cached.expires > Date.now()) {
      return cached;
    }
    try {
      const meta = await sock.groupMetadata(jid);
      const participants =
        (
          await Promise.all(
            meta.participants?.map(async (p) => {
              const mapped = await resolveInboundJid(p.id);
              return mapped ?? p.id;
            }) ?? [],
          )
        ).filter(Boolean) ?? [];
      const entry = {
        subject: meta.subject,
        participants,
        expires: Date.now() + GROUP_META_TTL_MS,
      };
      groupMetaCache.set(jid, entry);
      return entry;
    } catch (err) {
      logWhatsAppVerbose(
        options.verbose,
        `Failed to fetch group metadata for ${jid}: ${String(err)}`,
      );
      return { expires: Date.now() + GROUP_META_TTL_MS };
    }
  };

  type NormalizedInboundMessage = {
    id?: string;
    remoteJid: string;
    group: boolean;
    participantJid?: string;
    from: string;
    senderE164: string | null;
    groupSubject?: string;
    groupParticipants?: string[];
    messageTimestampMs?: number;
    access: Awaited<ReturnType<typeof checkInboundAccessControl>>;
  };

  const normalizeInboundMessage = async (
    msg: WAMessage,
  ): Promise<NormalizedInboundMessage | null> => {
    const id = msg.key?.id ?? undefined;
    const remoteJid = msg.key?.remoteJid;
    if (!remoteJid) {
      return null;
    }
    if (remoteJid.endsWith("@status") || remoteJid.endsWith("@broadcast")) {
      return null;
    }

    const group = isGroupJid(remoteJid);
    // Drop echoes of messages the gateway itself sent (tracked by sendTrackedMessage).
    // Applies to both groups and DMs/self-chat — without this, self-chat mode
    // re-processes the bot's own replies as new inbound user messages.
    if (
      Boolean(msg.key?.fromMe) &&
      id &&
      isRecentOutboundMessage({
        accountId: options.accountId,
        remoteJid,
        messageId: id,
      })
    ) {
      logWhatsAppVerbose(
        options.verbose,
        `Skipping recent outbound WhatsApp echo ${id} for ${remoteJid}`,
      );
      return null;
    }
    const participantJid = msg.key?.participant ?? undefined;

    const from = group ? remoteJid : await resolveInboundJid(remoteJid);
    if (!from) {
      return null;
    }
    const senderE164 = group
      ? participantJid
        ? await resolveInboundJid(participantJid)
        : null
      : from;

    let groupSubject: string | undefined;
    let groupParticipants: string[] | undefined;
    if (group) {
      const meta = await getGroupMeta(remoteJid);
      groupSubject = meta.subject;
      groupParticipants = meta.participants;
    }
    const messageTimestampMs = msg.messageTimestamp
      ? Number(msg.messageTimestamp) * 1000
      : undefined;

    const access = await checkInboundAccessControl({
      cfg: options.cfg,
      accountId: options.accountId,
      from,
      selfE164: self.e164 ?? null,
      senderE164,
      group,
      pushName: msg.pushName ?? undefined,
      isFromMe: Boolean(msg.key?.fromMe),
      messageTimestampMs,
      connectedAtMs,
      verbose: options.verbose,
      sock: {
        sendMessage: (jid: string, content: AnyMessageContent) => sendTrackedMessage(jid, content),
      },
      remoteJid,
    });
    if (!access.allowed) {
      return null;
    }

    return {
      id,
      remoteJid,
      group,
      participantJid,
      from,
      senderE164,
      groupSubject,
      groupParticipants,
      messageTimestampMs,
      access,
    };
  };

  const maybeMarkInboundAsRead = async (inbound: NormalizedInboundMessage) => {
    const { id, remoteJid, participantJid, access } = inbound;
    if (id && !access.isSelfChat && options.sendReadReceipts !== false) {
      try {
        await sock.readMessages([{ remoteJid, id, participant: participantJid, fromMe: false }]);
        const suffix = participantJid ? ` (participant ${participantJid})` : "";
        logWhatsAppVerbose(
          options.verbose,
          `Marked message ${id} as read for ${remoteJid}${suffix}`,
        );
      } catch (err) {
        logWhatsAppVerbose(options.verbose, `Failed to mark message ${id} read: ${String(err)}`);
      }
    } else if (id && access.isSelfChat && options.verbose) {
      // Self-chat mode: never auto-send read receipts (blue ticks) on behalf of the owner.
      logWhatsAppVerbose(options.verbose, `Self-chat mode: skipping read receipt for ${id}`);
    }
  };

  type EnrichedInboundMessage = {
    body: string;
    location?: ReturnType<typeof extractLocationData>;
    contactContext?: ReturnType<typeof extractContactContext>;
    replyContext?: ReturnType<typeof describeReplyContext>;
    mediaPath?: string;
    mediaType?: string;
    mediaFileName?: string;
  };

  const enrichInboundMessage = async (msg: WAMessage): Promise<EnrichedInboundMessage | null> => {
    const location = extractLocationData(msg.message ?? undefined);
    const locationText = location ? formatLocationText(location) : undefined;
    const contactContext = extractContactContext(msg.message ?? undefined);
    let body = extractText(msg.message ?? undefined);
    if (locationText) {
      body = [body, locationText].filter(Boolean).join("\n").trim();
    }
    if (!body) {
      body = extractMediaPlaceholder(msg.message ?? undefined);
      if (!body) {
        return null;
      }
    }
    const replyContext = describeReplyContext(msg.message as proto.IMessage | undefined);

    let mediaPath: string | undefined;
    let mediaType: string | undefined;
    let mediaFileName: string | undefined;
    try {
      const inboundMedia = await downloadInboundMedia(msg as proto.IWebMessageInfo, sock);
      if (inboundMedia) {
        const maxMb =
          typeof options.mediaMaxMb === "number" && options.mediaMaxMb > 0
            ? options.mediaMaxMb
            : 50;
        const maxBytes = maxMb * 1024 * 1024;
        const saved = await saveMediaBuffer(
          inboundMedia.buffer,
          inboundMedia.mimetype,
          "inbound",
          maxBytes,
          inboundMedia.fileName,
        );
        mediaPath = saved.path;
        mediaType = inboundMedia.mimetype;
        mediaFileName = inboundMedia.fileName;
      }
    } catch (err) {
      logWhatsAppVerbose(options.verbose, `Inbound media download failed: ${String(err)}`);
    }

    return {
      body,
      location: location ?? undefined,
      contactContext,
      replyContext,
      mediaPath,
      mediaType,
      mediaFileName,
    };
  };

  const enqueueInboundMessage = async (
    msg: WAMessage,
    inbound: NormalizedInboundMessage,
    enriched: EnrichedInboundMessage,
  ) => {
    const chatJid = inbound.remoteJid;
    const sendComposing = async () => {
      const currentSock = getCurrentSock();
      if (!currentSock) {
        return;
      }
      try {
        await currentSock.sendPresenceUpdate("composing", chatJid);
      } catch (err) {
        logWhatsAppVerbose(options.verbose, `Presence update failed: ${String(err)}`);
      }
    };
    // Auto-reply outbound goes through this path (not createWebSendApi —
    // that's the IPC/tools path). Run the registered outbound hook here so
    // self-only group / self-DM agent replies pick up the visual prefix
    // and react ✅ on completion against the inbound that triggered the
    // turn (designs/whatsapp.md §10.5; outbound-hook.ts WhatsAppOutboundContext).
    // Scoped per-call: each inbound has its own trigger id so retries /
    // multi-chunk follow-ups don't leak the wrong id.
    const inboundTriggerMessageId = inbound.id;
    const runOutboundHookForReply = async (
      text: string,
    ): Promise<{
      text: string;
      afterSend?: (sentMessageId: string) => Promise<void>;
    }> => {
      if (!text) {
        return { text };
      }
      const hook = getWhatsAppOutboundHook();
      if (!hook) {
        return { text };
      }
      try {
        const result = await hook({
          jid: chatJid,
          accountId: options.accountId,
          isGroup: inbound.group,
          text,
          inboundTriggerMessageId,
        });
        const effectiveText = typeof result.text === "string" ? result.text : text;
        const afterSend = result.afterSend;
        return {
          text: effectiveText,
          afterSend: afterSend
            ? async (sentMessageId: string) => {
                const currentSock = getCurrentSock();
                if (!currentSock) {
                  return;
                }
                try {
                  await afterSend({
                    jid: chatJid,
                    sock: currentSock,
                    sentMessageId,
                    inboundTriggerMessageId,
                  });
                } catch (err) {
                  // eslint-disable-next-line no-console
                  console.warn("[whatsapp monitor] outbound afterSend hook threw:", err);
                }
              }
            : undefined,
        };
      } catch {
        // Hook errors must not break the send.
        return { text };
      }
    };
    const resolveSentMessageId = (result: unknown): string => {
      return typeof result === "object" && result && "key" in result
        ? ((result as { key?: { id?: string } }).key?.id ?? "unknown")
        : "unknown";
    };
    const reply = async (text: string, sendOptions?: MiscMessageGenerationOptions) => {
      const hooked = await runOutboundHookForReply(text);
      const result = await sendTrackedMessage(chatJid, { text: hooked.text }, sendOptions);
      if (hooked.afterSend) {
        await hooked.afterSend(resolveSentMessageId(result));
      }
    };
    const sendMedia = async (
      payload: AnyMessageContent,
      sendOptions?: MiscMessageGenerationOptions,
    ) => {
      // Extract the user-visible text from whichever variant of
      // AnyMessageContent this is — caption for media, text for plain.
      // Hook only operates on text; media buffers pass through untouched.
      const payloadWithText = payload as { text?: string; caption?: string };
      const originalText = payloadWithText.text ?? payloadWithText.caption ?? "";
      const hooked = await runOutboundHookForReply(originalText);
      const transformedPayload: AnyMessageContent =
        hooked.text === originalText
          ? payload
          : "text" in payloadWithText && payloadWithText.text !== undefined
            ? ({ ...payload, text: hooked.text } as AnyMessageContent)
            : ({ ...payload, caption: hooked.text || undefined } as AnyMessageContent);
      const result = await sendTrackedMessage(chatJid, transformedPayload, sendOptions);
      if (hooked.afterSend) {
        await hooked.afterSend(resolveSentMessageId(result));
      }
    };
    const timestamp = inbound.messageTimestampMs;
    const mentionedJids = extractMentionedJids(msg.message as proto.IMessage | undefined);
    const senderName = msg.pushName ?? undefined;

    inboundLogger.info(
      {
        from: inbound.from,
        to: self.e164 ?? "me",
        body: enriched.body,
        mediaPath: enriched.mediaPath,
        mediaType: enriched.mediaType,
        mediaFileName: enriched.mediaFileName,
        timestamp,
      },
      "inbound message",
    );
    const inboundMessage: QueuedInboundMessage = {
      id: inbound.id,
      from: inbound.from,
      conversationId: inbound.from,
      to: self.e164 ?? "me",
      accountId: inbound.access.resolvedAccountId,
      body: enriched.body,
      pushName: senderName,
      timestamp,
      chatType: inbound.group ? "group" : "direct",
      chatId: inbound.remoteJid,
      sender: resolveComparableIdentity({
        jid: inbound.participantJid,
        e164: inbound.senderE164 ?? undefined,
        name: senderName,
      }),
      senderJid: inbound.participantJid,
      senderE164: inbound.senderE164 ?? undefined,
      senderName,
      replyTo: enriched.replyContext ?? undefined,
      replyToId: enriched.replyContext?.id,
      replyToBody: enriched.replyContext?.body,
      replyToSender: enriched.replyContext?.sender?.label ?? undefined,
      replyToSenderJid: enriched.replyContext?.sender?.jid ?? undefined,
      replyToSenderE164: enriched.replyContext?.sender?.e164 ?? undefined,
      groupSubject: inbound.groupSubject,
      groupParticipants: inbound.groupParticipants,
      mentions: mentionedJids ?? undefined,
      mentionedJids: mentionedJids ?? undefined,
      self,
      selfJid: self.jid ?? undefined,
      selfLid: self.lid ?? undefined,
      selfE164: self.e164 ?? undefined,
      fromMe: Boolean(msg.key?.fromMe),
      location: enriched.location ?? undefined,
      untrustedStructuredContext: enriched.contactContext
        ? [
            {
              label: "WhatsApp contact",
              source: "whatsapp",
              type: enriched.contactContext.kind,
              payload: enriched.contactContext,
            },
          ]
        : undefined,
      sendComposing,
      reply,
      sendMedia,
      mediaPath: enriched.mediaPath,
      mediaType: enriched.mediaType,
      mediaFileName: enriched.mediaFileName,
      dedupeKey: inbound.id ? `${options.accountId}:${inbound.remoteJid}:${inbound.id}` : undefined,
    };
    if (inboundMessage.id) {
      cacheInboundMessageMeta(inboundMessage.accountId, inboundMessage.chatId, inboundMessage.id, {
        participant: inboundMessage.senderJid,
        participantE164:
          inboundMessage.chatType === "direct" ? inboundMessage.senderE164 : undefined,
        body: inboundMessage.body,
        fromMe: inboundMessage.fromMe,
      });
    }
    try {
      const task = Promise.resolve(debouncer.enqueue(inboundMessage));
      void task.catch((err) => {
        inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
        inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
      });
    } catch (err) {
      inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
      inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
    }
  };

  const handleMessagesUpsert = async (upsert: { type?: string; messages?: Array<WAMessage> }) => {
    if (upsert.type !== "notify" && upsert.type !== "append") {
      return;
    }
    for (const msg of upsert.messages ?? []) {
      recordChannelActivity({
        channel: "whatsapp",
        accountId: options.accountId,
        direction: "inbound",
      });
      const inbound = await normalizeInboundMessage(msg);
      if (!inbound) {
        continue;
      }

      await maybeMarkInboundAsRead(inbound);

      // If this is history/offline catch-up, mark read above but skip auto-reply.
      if (upsert.type === "append") {
        const APPEND_RECENT_GRACE_MS = 60_000;
        const msgTsRaw = msg.messageTimestamp;
        const msgTsNum = msgTsRaw != null ? Number(msgTsRaw) : Number.NaN;
        const msgTsMs = Number.isFinite(msgTsNum) ? msgTsNum * 1000 : 0;
        if (msgTsMs < connectedAtMs - APPEND_RECENT_GRACE_MS) {
          continue;
        }
      }

      const enriched = await enrichInboundMessage(msg);
      if (!enriched) {
        continue;
      }

      const dedupeKey = inbound.id ? `${options.accountId}:${inbound.remoteJid}:${inbound.id}` : "";
      if (dedupeKey && !(await claimRecentInboundMessage(dedupeKey))) {
        continue;
      }

      await enqueueInboundMessage(msg, inbound, enriched);
    }
  };
  const handleConnectionUpdate = (
    update: Partial<import("@whiskeysockets/baileys").ConnectionState>,
  ) => {
    try {
      if (update.connection === "close") {
        if (options.socketRef?.current === sock) {
          options.socketRef.current = null;
        }
        const status = getStatusCode(update.lastDisconnect?.error);
        resolveClose({
          status,
          isLoggedOut: status === LOGGED_OUT_STATUS,
          error: update.lastDisconnect?.error,
        });
      }
    } catch (err) {
      inboundLogger.error({ error: String(err) }, "connection.update handler error");
      resolveClose({ status: undefined, isLoggedOut: false, error: err });
    }
  };
  const detachMessagesUpsert = attachEmitterListener(
    sock.ev as unknown as {
      on: (event: string, listener: (...args: unknown[]) => void) => void;
      off?: (event: string, listener: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
    },
    "messages.upsert",
    handleMessagesUpsert as unknown as (...args: unknown[]) => void,
  );
  const detachConnectionUpdate = attachEmitterListener(
    sock.ev as unknown as {
      on: (event: string, listener: (...args: unknown[]) => void) => void;
      off?: (event: string, listener: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
    },
    "connection.update",
    handleConnectionUpdate as unknown as (...args: unknown[]) => void,
  );

  void (async () => {
    try {
      const groups = await sock.groupFetchAllParticipating();
      logWhatsAppVerbose(
        options.verbose,
        `Hydrated ${Object.keys(groups ?? {}).length} participating groups on connect`,
      );
    } catch (err) {
      const error = String(err);
      inboundLogger.warn({ error }, "failed hydrating participating groups on connect");
      inboundConsoleLog.warn(`Failed hydrating participating groups on connect: ${error}`);
      logWhatsAppVerbose(
        options.verbose,
        `Failed to hydrate participating groups on connect: ${error}`,
      );
    }
  })();

  // Force a sender-key resync against the user's primary phone for our
  // known self-only groups. Without this, a gateway restart leaves the
  // Signal Sender Key chain out of sync — the primary keeps encrypting
  // group messages assuming we still hold its current key, and our side
  // drops every `skmsg` until the chain is rebuilt. See
  // ./sender-key-resync.ts for the full rationale + Baileys version notes.
  const selfOnlyGroupJids = collectSelfOnlyGroupJidsFromConfig(options.cfg, options.accountId);
  if (selfOnlyGroupJids.length > 0) {
    void runSenderKeyResyncOnConnect({
      sock,
      groupJids: selfOnlyGroupJids,
      verbose: options.verbose,
      abortSignal: options.disconnectRetryAbortSignal,
    }).catch((err) => {
      const error = String(err);
      inboundLogger.warn({ error }, "sender-key resync on connect failed");
      inboundConsoleLog.warn(`Sender-key resync on connect failed: ${error}`);
    });
  }

  const sendApi = createWebSendApi({
    sock: {
      sendMessage: (
        jid: string,
        content: AnyMessageContent,
        options?: MiscMessageGenerationOptions,
      ) => sendTrackedMessage(jid, content, options),
      sendPresenceUpdate: async (presence, jid?: string) => {
        const currentSock = getCurrentSock();
        if (!currentSock) {
          throw new Error(RECONNECT_IN_PROGRESS_ERROR);
        }
        return currentSock.sendPresenceUpdate(presence, jid);
      },
      groupCreate: async (subject: string, participants: string[]) => {
        const currentSock = getCurrentSock();
        if (!currentSock) {
          throw new Error(RECONNECT_IN_PROGRESS_ERROR);
        }
        return currentSock.groupCreate(subject, participants);
      },
    },
    defaultAccountId: options.accountId,
  });

  return {
    close: async () => {
      try {
        detachMessagesUpsert();
        detachConnectionUpdate();
        closeInboundMonitorSocket(sock);
      } catch (err) {
        logWhatsAppVerbose(options.verbose, `Socket close failed: ${String(err)}`);
      }
    },
    onClose,
    signalClose: (reason?: WebListenerCloseReason) => {
      resolveClose(reason ?? { status: undefined, isLoggedOut: false, error: "closed" });
    },
    // IPC surface (sendMessage/sendPoll/sendReaction/sendComposingTo)
    ...sendApi,
  } as const;
}

export async function monitorWebInbox(options: MonitorWebInboxOptions) {
  const sock = await createWaSocket(false, options.verbose, {
    authDir: options.authDir,
  });
  await waitForWaConnection(sock);
  return attachWebInboxToSocket({
    ...options,
    sock,
  });
}
