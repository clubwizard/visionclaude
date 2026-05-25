// Defensive model fallback for when Anthropic retires the configured model.
//
// Problem: if CLAUDE_MODEL is pinned to a model that Anthropic deprecates,
// every /chat starts 404'ing — a silent production outage until somebody
// notices the logs and updates .env. Bad week to be on holiday.
//
// Solution: keep a small "latest per family" map. When a chat call fails
// with a deprecation-shaped error, retry once against the latest model of
// the SAME family (sonnet → latest sonnet, opus → latest opus). Hot-patch
// the config so subsequent calls use the successor directly — we pay the
// retry cost exactly once per server lifetime. Log loudly so the operator
// knows to update .env at their leisure.
//
// We deliberately upgrade to LATEST rather than next-version-up because
// the configured model might be many versions behind by the time it's
// retired, and we don't want to bounce through "next then also next" and
// hit deprecation again. Latest is the safe single jump.

const LATEST_PER_FAMILY = {
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-7",
  // Haiku ID intentionally keeps the date suffix — Anthropic releases
  // small models with date-stamped IDs and no clean "4-5" alias.
  haiku: "claude-haiku-4-5-20251001",
} as const;

export type ModelFamily = keyof typeof LATEST_PER_FAMILY;

// Fallback when family can't be detected from the configured ID
// (e.g. a totally custom or typo'd model). Sonnet is the safe default —
// balanced cost + capability, always supported.
const FALLBACK_MODEL: string = LATEST_PER_FAMILY.sonnet;

export function detectFamily(modelId: string): ModelFamily | null {
  if (typeof modelId !== "string") return null;
  const lower = modelId.toLowerCase();
  if (lower.includes("sonnet")) return "sonnet";
  if (lower.includes("opus")) return "opus";
  if (lower.includes("haiku")) return "haiku";
  return null;
}

// Returns the latest model in the same family as `modelId`, or the
// fallback if the family can't be detected. May return `modelId` itself
// if the configured model IS already the latest — callers should compare
// before issuing a retry so they don't spin.
export function getSuccessor(modelId: string): string {
  const family = detectFamily(modelId);
  if (!family) return FALLBACK_MODEL;
  return LATEST_PER_FAMILY[family];
}

// Is `modelId` already the latest known model for its family?
// Used at startup so we can warn the operator without doing any I/O.
export function isLatestInFamily(modelId: string): boolean {
  const family = detectFamily(modelId);
  if (!family) return false;
  return LATEST_PER_FAMILY[family] === modelId;
}

// Detect "this looks like a deprecation error" from an Anthropic SDK
// exception or response. Matches:
//   - HTTP 404 (the most common case — Anthropic returns 404 with body
//     `{ error: { type: "not_found_error", message: "model: ..." } }`
//     when the model ID is unknown)
//   - error.type === "not_found_error"
//   - message contains "deprecated" / "retired" / "no longer supported"
//
// Does NOT match transient errors we should propagate as-is:
//   - 429 rate_limit_error
//   - 529 overloaded_error
//   - 401/403 auth errors
//   - network/timeout errors (no status code)
export function isModelDeprecationError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as {
    status?: number;
    error?: { type?: string; message?: string };
    message?: string;
  };
  if (e.status === 404) return true;
  if (e.error?.type === "not_found_error") return true;
  const message = (e.error?.message ?? e.message ?? "").toLowerCase();
  if (
    message.includes("model") &&
    (message.includes("deprecat") ||
      message.includes("retired") ||
      message.includes("no longer supported"))
  ) {
    return true;
  }
  return false;
}
