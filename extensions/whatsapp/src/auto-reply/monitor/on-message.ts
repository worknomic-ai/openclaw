import type { getReplyFromConfig } from "openclaw/plugin-sdk/reply-runtime";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { buildGroupHistoryKey } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveWhatsAppGroupSessionRoute } from "../../group-session-key.js";
import { getPrimaryIdentityId, getSenderIdentity } from "../../identity.js";
import { getWhatsAppInboundEventHook } from "../../inbound/inbound-event-hook.js";
import { formatError } from "../../session.js";
import { normalizeE164 } from "../../text-runtime.js";
import { loadConfig } from "../config.runtime.js";
import type { MentionConfig } from "../mentions.js";
import type { WebInboundMsg } from "../types.js";
import { maybeBroadcastMessage } from "./broadcast.js";
import type { EchoTracker } from "./echo.js";
import type { GroupHistoryEntry } from "./group-gating.js";
import { applyGroupGating } from "./group-gating.js";
import { updateLastRouteInBackground } from "./last-route.js";
import { resolvePeerId } from "./peer.js";
import { processMessage } from "./process-message.js";

// Fire the registered inbound-event hook for a message that has cleared
// every gate and is about to be dispatched to the agent. Errors from a
// misbehaving plugin must never break message flow — log via verbose and
// move on.
function fireInboundDispatched(params: {
  accountId: string;
  remoteJid: string;
  messageId: string;
  participantJid?: string;
  isGroup: boolean;
  verbose: boolean;
}): void {
  const hook = getWhatsAppInboundEventHook();
  if (!hook) return;
  try {
    const result = hook({
      kind: "dispatched",
      accountId: params.accountId,
      remoteJid: params.remoteJid,
      messageId: params.messageId,
      participantJid: params.participantJid,
      isGroup: params.isGroup,
    });
    if (result instanceof Promise) {
      result.catch((err) => {
        if (params.verbose) {
          logVerbose(`Inbound-event hook (dispatched) threw: ${formatError(err)}`);
        }
      });
    }
  } catch (err) {
    if (params.verbose) {
      logVerbose(`Inbound-event hook (dispatched) threw: ${formatError(err)}`);
    }
  }
}

export function createWebOnMessageHandler(params: {
  cfg: ReturnType<typeof loadConfig>;
  verbose: boolean;
  connectionId: string;
  maxMediaBytes: number;
  groupHistoryLimit: number;
  groupHistories: Map<string, GroupHistoryEntry[]>;
  groupMemberNames: Map<string, Map<string, string>>;
  echoTracker: EchoTracker;
  backgroundTasks: Set<Promise<unknown>>;
  replyResolver: typeof getReplyFromConfig;
  replyLogger: ReturnType<(typeof import("openclaw/plugin-sdk/runtime-env"))["getChildLogger"]>;
  baseMentionConfig: MentionConfig;
  account: { authDir?: string; accountId?: string; selfChatMode?: boolean };
}) {
  const processForRoute = async (
    msg: WebInboundMsg,
    route: ReturnType<typeof resolveAgentRoute>,
    groupHistoryKey: string,
    opts?: {
      groupHistory?: GroupHistoryEntry[];
      suppressGroupHistoryClear?: boolean;
    },
  ) =>
    processMessage({
      cfg: params.cfg,
      msg,
      route,
      groupHistoryKey,
      groupHistories: params.groupHistories,
      groupMemberNames: params.groupMemberNames,
      connectionId: params.connectionId,
      verbose: params.verbose,
      maxMediaBytes: params.maxMediaBytes,
      replyResolver: params.replyResolver,
      replyLogger: params.replyLogger,
      backgroundTasks: params.backgroundTasks,
      rememberSentText: params.echoTracker.rememberText,
      echoHas: params.echoTracker.has,
      echoForget: params.echoTracker.forget,
      buildCombinedEchoKey: params.echoTracker.buildCombinedKey,
      groupHistory: opts?.groupHistory,
      suppressGroupHistoryClear: opts?.suppressGroupHistoryClear,
    });

  return async (msg: WebInboundMsg) => {
    const conversationId = msg.conversationId ?? msg.from;
    const peerId = resolvePeerId(msg);
    // Fresh config for bindings lookup; other routing inputs are payload-derived.
    const baseRoute = resolveAgentRoute({
      cfg: loadConfig(),
      channel: "whatsapp",
      accountId: msg.accountId,
      peer: {
        kind: msg.chatType === "group" ? "group" : "direct",
        id: peerId,
      },
    });
    const route =
      msg.chatType === "group" ? resolveWhatsAppGroupSessionRoute(baseRoute) : baseRoute;
    const groupHistoryKey =
      msg.chatType === "group"
        ? buildGroupHistoryKey({
            channel: "whatsapp",
            accountId: route.accountId,
            peerKind: "group",
            peerId,
          })
        : route.sessionKey;

    // Same-phone mode logging retained
    if (msg.from === msg.to) {
      logVerbose(`📱 Same-phone mode detected (from === to: ${msg.from})`);
    }

    // Skip if this is a message we just sent (echo detection)
    if (params.echoTracker.has(msg.body)) {
      logVerbose("Skipping auto-reply: detected echo (message matches recently sent text)");
      params.echoTracker.forget(msg.body);
      return;
    }

    if (msg.chatType === "group") {
      const sender = getSenderIdentity(msg);
      const metaCtx = {
        From: msg.from,
        To: msg.to,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: msg.chatType,
        ConversationLabel: conversationId,
        GroupSubject: msg.groupSubject,
        SenderName: sender.name ?? undefined,
        SenderId: getPrimaryIdentityId(sender) ?? undefined,
        SenderE164: sender.e164 ?? undefined,
        Provider: "whatsapp",
        Surface: "whatsapp",
        OriginatingChannel: "whatsapp",
        OriginatingTo: conversationId,
      } satisfies MsgContext;
      updateLastRouteInBackground({
        cfg: params.cfg,
        backgroundTasks: params.backgroundTasks,
        storeAgentId: route.agentId,
        sessionKey: route.sessionKey,
        channel: "whatsapp",
        to: conversationId,
        accountId: route.accountId,
        ctx: metaCtx,
        warn: params.replyLogger.warn.bind(params.replyLogger),
      });

      const gating = await applyGroupGating({
        cfg: params.cfg,
        msg,
        conversationId,
        groupHistoryKey,
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        baseMentionConfig: params.baseMentionConfig,
        authDir: params.account.authDir,
        selfChatMode: params.account.selfChatMode,
        groupHistories: params.groupHistories,
        groupHistoryLimit: params.groupHistoryLimit,
        groupMemberNames: params.groupMemberNames,
        logVerbose,
        replyLogger: params.replyLogger,
      });
      if (!gating.shouldProcess) {
        return;
      }
    } else {
      // Ensure `peerId` for DMs is stable and stored as E.164 when possible.
      if (!msg.sender?.e164 && !msg.senderE164 && peerId && peerId.startsWith("+")) {
        const normalized = normalizeE164(peerId);
        if (normalized) {
          msg.sender = { ...msg.sender, e164: normalized };
          msg.senderE164 = normalized;
        }
      }
    }

    // Inbound-event hook: fire "dispatched" once per message that cleared
    // every gate (echo, system-jid, fromMe self-echo, access-control, and
    // group mention/activation gating). Plugins use this to apply visible
    // side-effects only when the agent is actually going to engage with
    // the message — e.g. 👀 reaction in self-only groups, mentioned group
    // messages, and self-DMs. Fired here (post-gating, pre-broadcast) so
    // a single inbound generates exactly one event regardless of broadcast
    // fan-out.
    if (msg.id) {
      fireInboundDispatched({
        accountId: msg.accountId,
        remoteJid: msg.chatId,
        messageId: msg.id,
        participantJid: msg.senderJid,
        isGroup: msg.chatType === "group",
        verbose: params.verbose,
      });
    }

    // Broadcast groups: when we'd reply anyway, run multiple agents.
    // Does not bypass group mention/activation gating above.
    if (
      await maybeBroadcastMessage({
        cfg: params.cfg,
        msg,
        peerId,
        route,
        groupHistoryKey,
        groupHistories: params.groupHistories,
        processMessage: processForRoute,
      })
    ) {
      return;
    }

    await processForRoute(msg, route, groupHistoryKey);
  };
}
