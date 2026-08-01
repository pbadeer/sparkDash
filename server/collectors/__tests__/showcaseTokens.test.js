/**
 * Unit tests for the 128k showcase token budget: content caps, context-window
 * clamping, scaled per-stream timeouts, and default bounds.
 * Run: npm test
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  clampMaxTokensToContext,
  contentCap,
  SHOWCASE_DEFAULTS,
} from "../ShowcaseManager.js";
import {
  STREAM_TIMEOUT_MAX_MS,
  streamTimeoutForTokens,
} from "../LlmStreaming.js";

test("showcase default bounds: min 64, max 128k", () => {
  assert.equal(SHOWCASE_DEFAULTS.minMaxTokens, 64);
  assert.equal(SHOWCASE_DEFAULTS.maxMaxTokens, 131_072);
  assert.equal(SHOWCASE_DEFAULTS.defaultMaxTokens, 512);
});

test("contentCap never clips a full 128k fill", () => {
  // ~4 chars/token → 128k tokens ≈ 512k chars. Cap must exceed that.
  const cap = contentCap(131_072);
  assert.ok(cap >= 131_072 * 4, `cap ${cap} < 128k tokens × 4 chars`);
  // Hard ceiling still bounds per-stream buffers.
  assert.ok(cap <= 2_000_000);
});

test("contentCap scales down for small budgets (no regression at defaults)", () => {
  assert.equal(contentCap(512), 512 * 8);
  assert.equal(contentCap(2048), 2048 * 8);
  assert.ok(contentCap(0) >= 1);
});

test("clampMaxTokensToContext clamps to the model window", () => {
  assert.equal(clampMaxTokensToContext(131_072, 32_768), 32_768);
  assert.equal(clampMaxTokensToContext(4096, 8192), 4096);
  assert.equal(clampMaxTokensToContext(131_072, 128_000), 128_000);
});

test("clampMaxTokensToContext no-ops when context is unknown", () => {
  assert.equal(clampMaxTokensToContext(131_072, null), 131_072);
  assert.equal(clampMaxTokensToContext(131_072, undefined), 131_072);
  assert.equal(clampMaxTokensToContext(131_072, NaN), 131_072);
  assert.equal(clampMaxTokensToContext(131_072, 0), 131_072);
});

test("clampMaxTokensToContext tolerates string / float inputs", () => {
  assert.equal(clampMaxTokensToContext("131072", "32768"), 32_768);
  assert.equal(clampMaxTokensToContext(100.9, 50.2), 50);
  assert.equal(clampMaxTokensToContext(10, 100), 10);
});

test("streamTimeoutForTokens scales with the token budget", () => {
  const small = streamTimeoutForTokens(2048);
  const large = streamTimeoutForTokens(131_072);
  assert.ok(large > small, `expected 128k timeout > 2k timeout`);
  assert.ok(small > 300_000, "2k fill still gets > 5 min");
  // 128k at the 20 tok/s floor ≈ 6553 s decode + 360 s base, well over an hour.
  assert.ok(large >= 6_000_000, `128k timeout ${large}ms should exceed 100 min`);
});

test("streamTimeoutForTokens is capped so hung streams still fail", () => {
  assert.equal(streamTimeoutForTokens(10_000_000), STREAM_TIMEOUT_MAX_MS);
  assert.ok(STREAM_TIMEOUT_MAX_MS <= 4 * 3_600_000);
});
