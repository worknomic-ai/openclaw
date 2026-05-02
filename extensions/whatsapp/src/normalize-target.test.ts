import { describe, expect, it } from "vitest";
import { looksLikeWhatsAppTargetId, validateWhatsAppTargetShape } from "./normalize-target.js";

describe("looksLikeWhatsAppTargetId", () => {
  it("recognizes E.164 phones, JIDs, and the whatsapp: prefix", () => {
    expect(looksLikeWhatsAppTargetId("+14155550100")).toBe(true);
    expect(looksLikeWhatsAppTargetId("14155550100@s.whatsapp.net")).toBe(true);
    expect(looksLikeWhatsAppTargetId("120363407163035063@g.us")).toBe(true);
    expect(looksLikeWhatsAppTargetId("whatsapp:+14155550100")).toBe(true);
  });
});

describe("validateWhatsAppTargetShape", () => {
  it("returns null for known-valid id shapes", () => {
    expect(validateWhatsAppTargetShape({ raw: "+14155550100" })).toBeNull();
    expect(validateWhatsAppTargetShape({ raw: "120363407163035063@g.us" })).toBeNull();
    expect(validateWhatsAppTargetShape({ raw: "14155550100@s.whatsapp.net" })).toBeNull();
    expect(validateWhatsAppTargetShape({ raw: "whatsapp:+14155550100" })).toBeNull();
  });

  it("rejects bare alphabetic names — primary LLM hallucination guard", () => {
    // Regression: pru's VM 2026-05-02 03:00 — Gemini emitted
    // `target: "dobby"` (the agent's own name) for a WhatsApp send.
    // Previously the directory pipeline returned a generic "Unknown
    // target" after a wasted lookup; now the shape validator rejects
    // immediately with structured detail.
    const result = validateWhatsAppTargetShape({ raw: "dobby" });
    expect(result).not.toBeNull();
    expect(result!.got).toBe("dobby");
    expect(result!.expected).toContain("E.164");
  });

  it("rejects empty + whitespace-only input", () => {
    expect(validateWhatsAppTargetShape({ raw: "" })).not.toBeNull();
    expect(validateWhatsAppTargetShape({ raw: "   " })).not.toBeNull();
  });

  it("rejects internal whitespace (E.164 + JIDs are whitespace-free)", () => {
    expect(validateWhatsAppTargetShape({ raw: "+1 415 555 0100" })).not.toBeNull();
    expect(validateWhatsAppTargetShape({ raw: "120363407163035063 @g.us" })).not.toBeNull();
  });

  it("does NOT reject ambiguous names (digits, dotted handles) — leaves them to the directory pipeline", () => {
    // Numeric strings might be partially-typed E.164 the directory can
    // resolve. Dotted handles might match a contact name. We only fail
    // fast when the shape is unambiguously wrong.
    expect(validateWhatsAppTargetShape({ raw: "415-555-0100" })).toBeNull();
    expect(validateWhatsAppTargetShape({ raw: "alice.smith" })).toBeNull();
  });
});
