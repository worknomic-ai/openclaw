import { afterEach, describe, expect, it, vi } from "vitest";
import { getWhatsAppInboundEventHook, setWhatsAppInboundEventHook } from "./inbound-event-hook.js";

describe("inbound-event-hook registry", () => {
  afterEach(() => {
    setWhatsAppInboundEventHook(null);
  });

  it("returns null when no hook is registered", () => {
    expect(getWhatsAppInboundEventHook()).toBeNull();
  });

  it("registers and reads back the same function (globalThis-backed registry)", () => {
    const hook = vi.fn();
    setWhatsAppInboundEventHook(hook);
    expect(getWhatsAppInboundEventHook()).toBe(hook);
  });

  it("clears the registry when set to null", () => {
    setWhatsAppInboundEventHook(vi.fn());
    setWhatsAppInboundEventHook(null);
    expect(getWhatsAppInboundEventHook()).toBeNull();
  });

  it("forwards the dispatched event payload through to the registered hook", async () => {
    const seen: Array<{ kind: string; messageId: string; isGroup: boolean }> = [];
    setWhatsAppInboundEventHook((event) => {
      seen.push({ kind: event.kind, messageId: event.messageId, isGroup: event.isGroup });
    });
    const hook = getWhatsAppInboundEventHook()!;
    await hook({
      kind: "dispatched",
      accountId: "default",
      remoteJid: "123@s.whatsapp.net",
      messageId: "M1",
      isGroup: false,
    });
    await hook({
      kind: "dispatched",
      accountId: "default",
      remoteJid: "120363xxx@g.us",
      messageId: "M2",
      participantJid: "456@s.whatsapp.net",
      isGroup: true,
    });
    expect(seen).toEqual([
      { kind: "dispatched", messageId: "M1", isGroup: false },
      { kind: "dispatched", messageId: "M2", isGroup: true },
    ]);
  });
});
