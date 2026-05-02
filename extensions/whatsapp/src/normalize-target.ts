import { normalizeE164 } from "openclaw/plugin-sdk/account-resolution";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

const WHATSAPP_USER_JID_RE = /^(\d+)(?::\d+)?@s\.whatsapp\.net$/i;
const WHATSAPP_LEGACY_USER_JID_RE = /^(\d+)@c\.us$/i;
const WHATSAPP_LID_RE = /^(\d+)@lid$/i;

function stripWhatsAppTargetPrefixes(value: string): string {
  let candidate = value.trim();
  for (;;) {
    const before = candidate;
    candidate = candidate.replace(/^whatsapp:/i, "").trim();
    if (candidate === before) {
      return candidate;
    }
  }
}

export function isWhatsAppGroupJid(value: string): boolean {
  const candidate = stripWhatsAppTargetPrefixes(value);
  const lower = normalizeLowercaseStringOrEmpty(candidate);
  if (!lower.endsWith("@g.us")) {
    return false;
  }
  const localPart = candidate.slice(0, candidate.length - "@g.us".length);
  if (!localPart || localPart.includes("@")) {
    return false;
  }
  return /^[0-9]+(-[0-9]+)*$/.test(localPart);
}

export function isWhatsAppUserTarget(value: string): boolean {
  const candidate = stripWhatsAppTargetPrefixes(value);
  return (
    WHATSAPP_USER_JID_RE.test(candidate) ||
    WHATSAPP_LEGACY_USER_JID_RE.test(candidate) ||
    WHATSAPP_LID_RE.test(candidate)
  );
}

function extractUserJidPhone(jid: string): string | null {
  const userMatch = jid.match(WHATSAPP_USER_JID_RE);
  if (userMatch) {
    return userMatch[1];
  }
  const legacyUserMatch = jid.match(WHATSAPP_LEGACY_USER_JID_RE);
  if (legacyUserMatch) {
    return legacyUserMatch[1];
  }
  const lidMatch = jid.match(WHATSAPP_LID_RE);
  if (lidMatch) {
    return lidMatch[1];
  }
  return null;
}

export function normalizeWhatsAppTarget(value: string): string | null {
  const candidate = stripWhatsAppTargetPrefixes(value);
  if (!candidate) {
    return null;
  }
  if (isWhatsAppGroupJid(candidate)) {
    const localPart = candidate.slice(0, candidate.length - "@g.us".length);
    return `${localPart}@g.us`;
  }
  if (isWhatsAppUserTarget(candidate)) {
    const phone = extractUserJidPhone(candidate);
    if (!phone) {
      return null;
    }
    const normalized = normalizeE164(phone);
    return normalized.length > 1 ? normalized : null;
  }
  if (candidate.includes("@")) {
    return null;
  }
  const normalized = normalizeE164(candidate);
  return normalized.length > 1 ? normalized : null;
}

export function normalizeWhatsAppMessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  return normalizeWhatsAppTarget(trimmed) ?? undefined;
}

export function normalizeWhatsAppAllowFromEntries(allowFrom: Array<string | number>): string[] {
  return allowFrom
    .map((entry) => String(entry).trim())
    .filter((entry): entry is string => Boolean(entry))
    .map((entry) => (entry === "*" ? entry : normalizeWhatsAppTarget(entry)))
    .filter((entry): entry is string => Boolean(entry));
}

export function looksLikeWhatsAppTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  return (
    /^whatsapp:/i.test(trimmed) ||
    isWhatsAppGroupJid(trimmed) ||
    isWhatsAppUserTarget(trimmed) ||
    normalizeWhatsAppTarget(trimmed) !== null
  );
}

// Structural shape validator for the WhatsApp target field. Wired into
// the channel's targetResolver.validateShape so resolveMessagingTarget
// rejects unambiguous junk (e.g. an agent's own name passed as the
// `target` for a message_send call) before any directory lookup or
// adapter call. Defense-in-depth against LLMs hallucinating ids —
// works regardless of model strength.
//
// Returns null when the shape MIGHT be valid (the directory lookup +
// id-resolution pipeline owns the final yes/no in those cases). Returns
// a structured rejection only when the shape is definitively wrong:
//   - empty / whitespace
//   - contains internal whitespace (E.164 + JIDs are whitespace-free)
//   - looks like a bare alphabetic name (no @, no +, no digits) and
//     doesn't match any of the WA-specific shapes the resolver knows
//     about — these would always fall through to "Unknown target" in
//     the directory layer, so we fail fast with actionable detail.
export function validateWhatsAppTargetShape(params: {
  raw: string;
}): { expected: string; got: string } | null {
  const trimmed = params.raw.trim();
  const expected =
    "E.164 phone (e.g. +14155550100), `<jid>@s.whatsapp.net`, or group JID `<id>@g.us`";
  if (!trimmed) {
    return { expected, got: params.raw };
  }
  // Internal whitespace is structurally invalid for every WA target shape.
  if (/\s/.test(trimmed)) {
    return { expected, got: trimmed };
  }
  // Already passes the existing id-shape check: leave it alone — caller
  // pipeline will resolve via id-resolution.
  if (looksLikeWhatsAppTargetId(trimmed)) {
    return null;
  }
  // Bare alphabetic single tokens (no digits, dots, dashes, `@`, or
  // `+`) are never valid WA targets. Catches the primary LLM failure
  // mode — passing the agent's own name ("dobby") or the user's first
  // name. Intentionally narrow: dotted handles (`alice.smith`) and
  // dashed strings might match a directory contact, so we leave those
  // to the directory pipeline rather than failing them up-front.
  if (/^[A-Za-z]+$/.test(trimmed)) {
    return { expected, got: trimmed };
  }
  // Anything else (digits with no plus, dotted handles, partially-shaped
  // jids that don't match the existing checks) — let the directory
  // pipeline have a crack at it. Better to surface "Unknown target" than
  // false-reject a contact name the directory might match.
  return null;
}
