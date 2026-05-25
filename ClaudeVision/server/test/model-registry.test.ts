import { describe, it, expect } from "vitest";
import {
  detectFamily,
  getSuccessor,
  isLatestInFamily,
  isModelDeprecationError,
} from "../src/model-registry.js";

describe("detectFamily", () => {
  it("identifies family from current-era IDs", () => {
    expect(detectFamily("claude-sonnet-4-6")).toBe("sonnet");
    expect(detectFamily("claude-opus-4-7")).toBe("opus");
    expect(detectFamily("claude-haiku-4-5-20251001")).toBe("haiku");
  });

  it("identifies family from older dated IDs", () => {
    expect(detectFamily("claude-sonnet-4-20250514")).toBe("sonnet");
    expect(detectFamily("claude-opus-4-20250514")).toBe("opus");
  });

  it("is case-insensitive", () => {
    expect(detectFamily("CLAUDE-SONNET-4-6")).toBe("sonnet");
  });

  it("returns null for unknown models", () => {
    expect(detectFamily("gpt-4o")).toBeNull();
    expect(detectFamily("")).toBeNull();
    expect(detectFamily(null as unknown as string)).toBeNull();
  });
});

describe("getSuccessor", () => {
  it("returns a same-family latest for known families", () => {
    expect(getSuccessor("claude-sonnet-4-20250514")).toContain("sonnet");
    expect(getSuccessor("claude-opus-4-20250514")).toContain("opus");
    expect(getSuccessor("claude-haiku-3")).toContain("haiku");
  });

  it("returns the sonnet fallback for unknown models", () => {
    // Sonnet is the default — balanced cost + capability.
    expect(getSuccessor("gpt-4o")).toContain("sonnet");
    expect(getSuccessor("some-totally-made-up-model")).toContain("sonnet");
  });

  it("can return the same model if it is already the latest", () => {
    // Same-model returns are the caller's signal to NOT retry.
    const latestSonnet = getSuccessor("claude-sonnet-foo");
    expect(getSuccessor(latestSonnet)).toBe(latestSonnet);
  });
});

describe("isLatestInFamily", () => {
  it("true only for the exact latest model per family", () => {
    expect(isLatestInFamily(getSuccessor("claude-sonnet-x"))).toBe(true);
    expect(isLatestInFamily(getSuccessor("claude-opus-x"))).toBe(true);
  });

  it("false for older same-family models", () => {
    expect(isLatestInFamily("claude-sonnet-4-20250514")).toBe(false);
  });

  it("false for unknown families", () => {
    expect(isLatestInFamily("gpt-4o")).toBe(false);
  });
});

describe("isModelDeprecationError", () => {
  it("flags HTTP 404 as deprecation", () => {
    expect(isModelDeprecationError({ status: 404 })).toBe(true);
  });

  it("flags Anthropic-shaped not_found_error body", () => {
    expect(
      isModelDeprecationError({
        status: 404,
        error: { type: "not_found_error", message: "model: claude-sonnet-3" },
      })
    ).toBe(true);
  });

  it("flags messages mentioning 'deprecated' / 'retired' / 'no longer supported'", () => {
    expect(
      isModelDeprecationError({
        status: 400,
        error: { type: "invalid_request_error", message: "Model claude-x is deprecated." },
      })
    ).toBe(true);
    expect(
      isModelDeprecationError({
        message: "model has been retired",
      })
    ).toBe(true);
    expect(
      isModelDeprecationError({
        error: { message: "this model is no longer supported" },
      })
    ).toBe(true);
  });

  it("does NOT flag transient errors", () => {
    expect(isModelDeprecationError({ status: 429 })).toBe(false); // rate limit
    expect(isModelDeprecationError({ status: 529 })).toBe(false); // overloaded
    expect(isModelDeprecationError({ status: 401 })).toBe(false); // auth
    expect(isModelDeprecationError({ status: 500 })).toBe(false); // server error
    expect(
      isModelDeprecationError({
        status: 400,
        error: { type: "invalid_request_error", message: "bad input" },
      })
    ).toBe(false);
  });

  it("does NOT flag network / non-object errors", () => {
    expect(isModelDeprecationError(new Error("ECONNRESET"))).toBe(false);
    expect(isModelDeprecationError("nope")).toBe(false);
    expect(isModelDeprecationError(null)).toBe(false);
    expect(isModelDeprecationError(undefined)).toBe(false);
  });
});
