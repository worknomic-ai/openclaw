import type { GroupMetadata } from "@whiskeysockets/baileys";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import {
  collectSelfOnlyGroupJidsFromConfig,
  runSenderKeyResyncOnConnect,
} from "./sender-key-resync.js";

type ResyncSock = Parameters<typeof runSenderKeyResyncOnConnect>[0]["sock"];

function buildSock() {
  const groupMeta: GroupMetadata = {
    id: "x",
    subject: "x",
    participants: [],
    owner: undefined,
  };
  return {
    authState: {
      keys: {
        set: vi.fn(async () => {}),
      },
    } as unknown as ResyncSock["authState"],
    groupMetadata: vi.fn<(jid: string) => Promise<GroupMetadata>>(async () => groupMeta),
    presenceSubscribe: vi.fn<(jid: string) => Promise<void>>(async () => undefined),
  } satisfies ResyncSock;
}

describe("collectSelfOnlyGroupJidsFromConfig", () => {
  it("returns group JIDs from account.groups keys", () => {
    const cfg = {
      channels: {
        whatsapp: {
          accounts: {
            default: {
              groups: {
                "1234@g.us": { requireMention: false },
                "5678@g.us": { requireMention: false },
              },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(collectSelfOnlyGroupJidsFromConfig(cfg, "default").toSorted()).toEqual([
      "1234@g.us",
      "5678@g.us",
    ]);
  });

  it("includes only group-shaped entries from groupAllowFrom", () => {
    const cfg = {
      channels: {
        whatsapp: {
          accounts: {
            default: {
              groupAllowFrom: ["1234@g.us", "+15551234567"],
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(collectSelfOnlyGroupJidsFromConfig(cfg, "default")).toEqual(["1234@g.us"]);
  });

  it("returns empty array when account is missing", () => {
    const cfg = { channels: { whatsapp: { accounts: {} } } } as unknown as OpenClawConfig;
    expect(collectSelfOnlyGroupJidsFromConfig(cfg, "default")).toEqual([]);
  });

  it("dedupes entries that appear in both groups and groupAllowFrom", () => {
    const cfg = {
      channels: {
        whatsapp: {
          accounts: {
            default: {
              groups: { "1234@g.us": { requireMention: false } },
              groupAllowFrom: ["1234@g.us"],
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    expect(collectSelfOnlyGroupJidsFromConfig(cfg, "default")).toEqual(["1234@g.us"]);
  });
});

describe("runSenderKeyResyncOnConnect", () => {
  it("clears sender-key-memory, refreshes metadata, and subscribes to presence per JID", async () => {
    const sock = buildSock();
    await runSenderKeyResyncOnConnect({
      sock,
      groupJids: ["a@g.us", "b@g.us"],
      verbose: false,
      delayMs: 0,
    });

    expect(sock.authState.keys.set).toHaveBeenCalledTimes(2);
    expect(sock.authState.keys.set).toHaveBeenNthCalledWith(1, {
      "sender-key-memory": { "a@g.us": null },
    });
    expect(sock.authState.keys.set).toHaveBeenNthCalledWith(2, {
      "sender-key-memory": { "b@g.us": null },
    });
    expect(sock.groupMetadata).toHaveBeenCalledTimes(2);
    expect(sock.presenceSubscribe).toHaveBeenCalledTimes(2);
  });

  it("filters non-group JIDs", async () => {
    const sock = buildSock();
    await runSenderKeyResyncOnConnect({
      sock,
      groupJids: ["a@g.us", "+15551234567", ""],
      verbose: false,
      delayMs: 0,
    });
    expect(sock.groupMetadata).toHaveBeenCalledTimes(1);
    expect(sock.groupMetadata).toHaveBeenCalledWith("a@g.us");
  });

  it("continues after a per-JID failure", async () => {
    const sock = buildSock();
    const fallbackMeta: GroupMetadata = {
      id: "b",
      subject: "b",
      participants: [],
      owner: undefined,
    };
    sock.groupMetadata
      .mockImplementationOnce(async () => {
        throw new Error("not a participant");
      })
      .mockImplementationOnce(async () => fallbackMeta);

    await runSenderKeyResyncOnConnect({
      sock,
      groupJids: ["a@g.us", "b@g.us"],
      verbose: false,
      delayMs: 0,
    });

    expect(sock.authState.keys.set).toHaveBeenCalledTimes(2);
    // first JID: groupMetadata threw, presenceSubscribe should NOT be called
    // second JID: should still get the full sequence
    expect(sock.presenceSubscribe).toHaveBeenCalledTimes(1);
    expect(sock.presenceSubscribe).toHaveBeenCalledWith("b@g.us");
  });

  it("aborts cleanly when the abort signal fires before the settle delay", async () => {
    const sock = buildSock();
    const controller = new AbortController();
    controller.abort();
    await runSenderKeyResyncOnConnect({
      sock,
      groupJids: ["a@g.us"],
      verbose: false,
      delayMs: 1000,
      abortSignal: controller.signal,
    });
    expect(sock.groupMetadata).not.toHaveBeenCalled();
    expect(sock.presenceSubscribe).not.toHaveBeenCalled();
    expect(sock.authState.keys.set).not.toHaveBeenCalled();
  });

  it("is a no-op when the JID list is empty", async () => {
    const sock = buildSock();
    await runSenderKeyResyncOnConnect({
      sock,
      groupJids: [],
      verbose: false,
      delayMs: 0,
    });
    expect(sock.authState.keys.set).not.toHaveBeenCalled();
    expect(sock.groupMetadata).not.toHaveBeenCalled();
    expect(sock.presenceSubscribe).not.toHaveBeenCalled();
  });
});
