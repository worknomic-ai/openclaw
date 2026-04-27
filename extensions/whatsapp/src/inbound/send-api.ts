import type {
  AnyMessageContent,
  MiscMessageGenerationOptions,
  WAPresence,
  WASocket,
} from "@whiskeysockets/baileys";
import { recordChannelActivity } from "openclaw/plugin-sdk/infra-runtime";
import { buildQuotedMessageOptions } from "../quoted-message.js";
import { toWhatsappJid } from "../text-runtime.js";
import { getWhatsAppOutboundHook, type WhatsAppOutboundResult } from "./outbound-hook.js";
import type { ActiveWebSendOptions } from "./types.js";

function recordWhatsAppOutbound(accountId: string) {
  recordChannelActivity({
    channel: "whatsapp",
    accountId,
    direction: "outbound",
  });
}

function resolveOutboundMessageId(result: unknown): string {
  return typeof result === "object" && result && "key" in result
    ? ((result as { key?: { id?: string } }).key?.id ?? "unknown")
    : "unknown";
}

type SendApiSock = {
  sendMessage: (
    jid: string,
    content: AnyMessageContent,
    options?: MiscMessageGenerationOptions,
  ) => Promise<unknown>;
  sendPresenceUpdate: (presence: WAPresence, jid?: string) => Promise<unknown>;
  groupCreate?: (subject: string, participants: string[]) => Promise<{ id: string }>;
  chatModify?: WASocket["chatModify"];
};

export function createWebSendApi(params: { sock: SendApiSock; defaultAccountId: string }) {
  return {
    sendMessage: async (
      to: string,
      text: string,
      mediaBuffer?: Buffer,
      mediaType?: string,
      sendOptions?: ActiveWebSendOptions,
    ): Promise<{ messageId: string }> => {
      const jid = toWhatsappJid(to);
      const accountId = sendOptions?.accountId ?? params.defaultAccountId;

      // Plugin-provided outbound transform (optional). Applies when there
      // is non-empty text (text-only OR media-with-caption — for the
      // latter the caption IS the text payload). Hook returns replacement
      // text and/or an afterSend callback that runs once the send resolves.
      // agentId / agentDisplayName / inboundTriggerMessageId are passed
      // through from the outbound caller so the plugin can apply per-agent
      // transforms (visual prefix, completion reactions). Their absence
      // is fine — the hook handles non-agent sends (e.g. pairing replies)
      // by no-op'ing.
      let effectiveText = text;
      let afterSend: WhatsAppOutboundResult["afterSend"] | undefined;
      const inboundTriggerMessageId = sendOptions?.inboundTriggerMessageId;
      if (text) {
        const hook = getWhatsAppOutboundHook();
        if (hook) {
          try {
            const result = await hook({
              jid,
              accountId,
              isGroup: jid.endsWith("@g.us"),
              text,
              agentId: sendOptions?.agentId,
              agentDisplayName: sendOptions?.agentDisplayName,
              inboundTriggerMessageId,
            });
            if (typeof result.text === "string") {
              effectiveText = result.text;
            }
            afterSend = result.afterSend;
          } catch {
            // Hook errors must not break the send.
          }
        }
      }

      let payload: AnyMessageContent;
      if (mediaBuffer) {
        mediaType ??= "application/octet-stream";
      }
      if (mediaBuffer && mediaType) {
        if (mediaType.startsWith("image/")) {
          payload = {
            image: mediaBuffer,
            caption: effectiveText || undefined,
            mimetype: mediaType,
          };
        } else if (mediaType.startsWith("audio/")) {
          payload = { audio: mediaBuffer, ptt: true, mimetype: mediaType };
        } else if (mediaType.startsWith("video/")) {
          const gifPlayback = sendOptions?.gifPlayback;
          payload = {
            video: mediaBuffer,
            caption: effectiveText || undefined,
            mimetype: mediaType,
            ...(gifPlayback ? { gifPlayback: true } : {}),
          };
        } else {
          const fileName = sendOptions?.fileName?.trim() || "file";
          payload = {
            document: mediaBuffer,
            fileName,
            caption: effectiveText || undefined,
            mimetype: mediaType,
          };
        }
      } else {
        payload = { text: effectiveText };
      }
      const quotedOpts = buildQuotedMessageOptions({
        messageId: sendOptions?.quotedMessageKey?.id,
        remoteJid: sendOptions?.quotedMessageKey?.remoteJid,
        fromMe: sendOptions?.quotedMessageKey?.fromMe,
        participant: sendOptions?.quotedMessageKey?.participant,
        messageText: sendOptions?.quotedMessageKey?.messageText,
      });
      const result = quotedOpts
        ? await params.sock.sendMessage(jid, payload, quotedOpts)
        : await params.sock.sendMessage(jid, payload);
      recordWhatsAppOutbound(accountId);
      const messageId = resolveOutboundMessageId(result);
      if (afterSend) {
        try {
          await afterSend({
            jid,
            sock: params.sock as WASocket,
            sentMessageId: messageId,
            inboundTriggerMessageId,
          });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn("[whatsapp send-api] outbound afterSend hook threw:", err);
        }
      }
      return { messageId };
    },
    sendPoll: async (
      to: string,
      poll: { question: string; options: string[]; maxSelections?: number },
    ): Promise<{ messageId: string }> => {
      const jid = toWhatsappJid(to);
      const result = await params.sock.sendMessage(jid, {
        poll: {
          name: poll.question,
          values: poll.options,
          selectableCount: poll.maxSelections ?? 1,
        },
      } as AnyMessageContent);
      recordWhatsAppOutbound(params.defaultAccountId);
      const messageId = resolveOutboundMessageId(result);
      return { messageId };
    },
    sendReaction: async (
      chatJid: string,
      messageId: string,
      emoji: string,
      fromMe: boolean,
      participant?: string,
    ): Promise<void> => {
      const jid = toWhatsappJid(chatJid);
      await params.sock.sendMessage(jid, {
        react: {
          text: emoji,
          key: {
            remoteJid: jid,
            id: messageId,
            fromMe,
            participant: participant ? toWhatsappJid(participant) : undefined,
          },
        },
      } as AnyMessageContent);
    },
    sendComposingTo: async (to: string): Promise<void> => {
      const jid = toWhatsappJid(to);
      await params.sock.sendPresenceUpdate("composing", jid);
    },
    groupCreate: async (subject: string, participants: string[] = []): Promise<{ jid: string }> => {
      // WhatsApp now supports zero-participant (self-only) groups; passing
      // an empty array is intentional for Clawsy's per-agent-thread model.
      if (!params.sock.groupCreate) {
        throw new Error("groupCreate not supported by this socket adapter");
      }
      const result = await params.sock.groupCreate(subject, participants);
      return { jid: result.id };
    },
  } as const;
}
