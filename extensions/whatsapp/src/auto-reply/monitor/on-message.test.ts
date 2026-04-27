import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mocks. We replace the heavy dependencies on-message pulls in so
// the only thing we exercise is the gating-→-dispatch wiring that decides
// whether the inbound-event hook fires.
const { applyGroupGatingMock, processMessageMock, maybeBroadcastMock } = vi.hoisted(() => ({
  applyGroupGatingMock: vi.fn(),
  processMessageMock: vi.fn(),
  maybeBroadcastMock: vi.fn(async () => false),
}));

vi.mock("./group-gating.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./group-gating.js")>();
  return { ...actual, applyGroupGating: applyGroupGatingMock };
});

vi.mock("./process-message.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./process-message.js")>();
  return { ...actual, processMessage: processMessageMock };
});

vi.mock("./broadcast.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./broadcast.js")>();
  return { ...actual, maybeBroadcastMessage: maybeBroadcastMock };
});

vi.mock("./last-route.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./last-route.js")>();
  return { ...actual, updateLastRouteInBackground: () => {} };
});

vi.mock("./peer.js", () => ({
  resolvePeerId: (msg: { from: string }) => msg.from,
}));

vi.mock("openclaw/plugin-sdk/routing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/routing")>();
  return {
    ...actual,
    resolveAgentRoute: () => ({
      agentId: "main",
      channel: "whatsapp",
      accountId: "default",
      sessionKey: "agent:main:whatsapp:group:G",
      mainSessionKey: "agent:main:whatsapp:group:G",
      lastRoutePolicy: "main",
      matchedBy: "default",
    }),
    buildGroupHistoryKey: () => "whatsapp:default:group:G",
  };
});

vi.mock("../../group-session-key.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../group-session-key.js")>();
  return {
    ...actual,
    resolveWhatsAppGroupSessionRoute: <T>(route: T): T => route,
  };
});

vi.mock("../../identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../identity.js")>();
  return {
    ...actual,
    getPrimaryIdentityId: () => null,
    getSenderIdentity: () => ({ name: "Alice", e164: "+15550002222" }),
  };
});

vi.mock("../config.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.runtime.js")>();
  return { ...actual, loadConfig: () => ({}) };
});

import {
  getWhatsAppInboundEventHook,
  setWhatsAppInboundEventHook,
  type WhatsAppInboundEventHook,
} from "../../inbound/inbound-event-hook.js";
import { createWebOnMessageHandler } from "./on-message.js";

const GROUP_JID = "120363xxx@g.us";
const DM_JID = "+15551234567";
const PARTICIPANT_JID = "15550002222@s.whatsapp.net";

function makeHandler() {
  return createWebOnMessageHandler({
    cfg: {} as never,
    verbose: false,
    connectionId: "conn-1",
    maxMediaBytes: 1024,
    groupHistoryLimit: 10,
    groupHistories: new Map(),
    groupMemberNames: new Map(),
    echoTracker: {
      has: () => false,
      forget: () => {},
      rememberText: () => {},
      buildCombinedKey: ({ sessionKey }: { sessionKey: string }) => sessionKey,
    } as never,
    backgroundTasks: new Set(),
    replyResolver: (async () => undefined) as never,
    replyLogger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as never,
    baseMentionConfig: {} as never,
    account: { authDir: "/tmp", accountId: "default", selfChatMode: false },
  });
}

function makeGroupMsg(overrides: Record<string, unknown> = {}) {
  return {
    id: "M-group",
    from: GROUP_JID,
    to: "+15550001111",
    conversationId: GROUP_JID,
    accountId: "default",
    chatId: GROUP_JID,
    chatType: "group" as const,
    body: "hi",
    senderJid: PARTICIPANT_JID,
    sendComposing: async () => {},
    reply: async () => {},
    sendMedia: async () => {},
    ...overrides,
  };
}

function makeDmMsg(overrides: Record<string, unknown> = {}) {
  return {
    id: "M-dm",
    from: DM_JID,
    to: "+15550001111",
    conversationId: DM_JID,
    accountId: "default",
    chatId: DM_JID,
    chatType: "direct" as const,
    body: "hi",
    sendComposing: async () => {},
    reply: async () => {},
    sendMedia: async () => {},
    ...overrides,
  };
}

describe("createWebOnMessageHandler dispatched-event firing", () => {
  let hookFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    applyGroupGatingMock.mockReset();
    processMessageMock.mockReset();
    maybeBroadcastMock.mockReset().mockResolvedValue(false);
    hookFn = vi.fn();
    setWhatsAppInboundEventHook(hookFn as unknown as WhatsAppInboundEventHook);
  });

  afterEach(() => {
    setWhatsAppInboundEventHook(null);
  });

  it("fires `dispatched` exactly once when group mention-gating allows the message", async () => {
    applyGroupGatingMock.mockResolvedValueOnce({ shouldProcess: true });
    const handler = makeHandler();
    await handler(makeGroupMsg() as never);
    expect(hookFn).toHaveBeenCalledTimes(1);
    expect(hookFn).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "dispatched",
        accountId: "default",
        remoteJid: GROUP_JID,
        messageId: "M-group",
        participantJid: PARTICIPANT_JID,
        isGroup: true,
      }),
    );
    // And the message actually went on to be dispatched.
    expect(processMessageMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire `dispatched` when group mention-gating rejects the message", async () => {
    applyGroupGatingMock.mockResolvedValueOnce({ shouldProcess: false });
    const handler = makeHandler();
    await handler(makeGroupMsg() as never);
    expect(hookFn).not.toHaveBeenCalled();
    expect(processMessageMock).not.toHaveBeenCalled();
  });

  it("fires `dispatched` for a DM that reached the handler (access-control already passed upstream)", async () => {
    const handler = makeHandler();
    await handler(makeDmMsg() as never);
    expect(hookFn).toHaveBeenCalledTimes(1);
    expect(hookFn).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "dispatched",
        remoteJid: DM_JID,
        messageId: "M-dm",
        isGroup: false,
        participantJid: undefined,
      }),
    );
    expect(processMessageMock).toHaveBeenCalledTimes(1);
  });

  it("fires `dispatched` only once even when broadcast fan-out runs multiple agents", async () => {
    applyGroupGatingMock.mockResolvedValueOnce({ shouldProcess: true });
    // broadcast returning true short-circuits the trailing processForRoute,
    // and is itself responsible for invoking processForRoute per agent —
    // we should still see a single dispatched event for the inbound.
    maybeBroadcastMock.mockResolvedValueOnce(true);
    const handler = makeHandler();
    await handler(makeGroupMsg() as never);
    expect(hookFn).toHaveBeenCalledTimes(1);
  });

  it("does not fire `dispatched` for an echo (message dropped before gating)", async () => {
    const handler = createWebOnMessageHandler({
      cfg: {} as never,
      verbose: false,
      connectionId: "conn-1",
      maxMediaBytes: 1024,
      groupHistoryLimit: 10,
      groupHistories: new Map(),
      groupMemberNames: new Map(),
      echoTracker: {
        has: () => true,
        forget: () => {},
        rememberText: () => {},
        buildCombinedKey: ({ sessionKey }: { sessionKey: string }) => sessionKey,
      } as never,
      backgroundTasks: new Set(),
      replyResolver: (async () => undefined) as never,
      replyLogger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      } as never,
      baseMentionConfig: {} as never,
      account: { authDir: "/tmp", accountId: "default", selfChatMode: false },
    });
    await handler(makeDmMsg() as never);
    expect(hookFn).not.toHaveBeenCalled();
    expect(processMessageMock).not.toHaveBeenCalled();
  });

  it("swallows synchronous hook errors so the message pipeline continues", async () => {
    setWhatsAppInboundEventHook(() => {
      throw new Error("plugin blew up");
    });
    applyGroupGatingMock.mockResolvedValueOnce({ shouldProcess: true });
    const handler = makeHandler();
    await expect(handler(makeGroupMsg() as never)).resolves.toBeUndefined();
    expect(processMessageMock).toHaveBeenCalledTimes(1);
  });

  it("does nothing when no hook is registered", async () => {
    setWhatsAppInboundEventHook(null);
    applyGroupGatingMock.mockResolvedValueOnce({ shouldProcess: true });
    const handler = makeHandler();
    await handler(makeGroupMsg() as never);
    // No assertions needed beyond the call not throwing — the registry
    // returning null short-circuits.
    expect(getWhatsAppInboundEventHook()).toBeNull();
    expect(processMessageMock).toHaveBeenCalledTimes(1);
  });
});
