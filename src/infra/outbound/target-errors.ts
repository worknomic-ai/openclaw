export function missingTargetMessage(provider: string, hint?: string): string {
  return `Delivering to ${provider} requires target${formatTargetHint(hint)}`;
}

export function missingTargetError(provider: string, hint?: string): Error {
  return new Error(missingTargetMessage(provider, hint));
}

export function ambiguousTargetMessage(provider: string, raw: string, hint?: string): string {
  return `Ambiguous target "${raw}" for ${provider}. Provide a unique name or an explicit id.${formatTargetHint(hint, true)}`;
}

export function ambiguousTargetError(provider: string, raw: string, hint?: string): Error {
  return new Error(ambiguousTargetMessage(provider, raw, hint));
}

export function unknownTargetMessage(provider: string, raw: string, hint?: string): string {
  return `Unknown target "${raw}" for ${provider}.${formatTargetHint(hint, true)}`;
}

export function unknownTargetError(provider: string, raw: string, hint?: string): Error {
  return new Error(unknownTargetMessage(provider, raw, hint));
}

export function invalidTargetShapeMessage(provider: string, raw: string, expected: string): string {
  // Phrased so the LLM (and human operators) see actionable specifics:
  // what was passed, what shape this provider expects, and that the
  // rejection is structural — no point retrying with the same id.
  return (
    `Invalid target shape for ${provider}: got "${raw}", expected ${expected}. ` +
    `Provide a structurally-valid id; the system rejects shape mismatches up-front ` +
    `before any send is attempted.`
  );
}

export function invalidTargetShapeError(provider: string, raw: string, expected: string): Error {
  return new Error(invalidTargetShapeMessage(provider, raw, expected));
}

function formatTargetHint(hint?: string, withLabel = false): string {
  const normalized = hint?.trim();
  if (!normalized) {
    return "";
  }
  return withLabel ? ` Hint: ${normalized}` : ` ${normalized}`;
}
