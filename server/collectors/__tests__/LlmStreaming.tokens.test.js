/**
 * Unit tests for live token estimation (SSE chunks ≠ tokens when batched).
 * Run: npm test
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { estimateTokenCount, promptTpsFromTtft, round2, readServerTokenCounters, readServerGenerationTokens } from "../LlmStreaming.js";

test("estimateTokenCount: empty → 0", () => {
  assert.equal(estimateTokenCount(""), 0);
  assert.equal(estimateTokenCount(null), 0);
  assert.equal(estimateTokenCount(undefined), 0);
});

test("estimateTokenCount: short non-empty text → at least 1", () => {
  assert.equal(estimateTokenCount("hi"), 1);
  assert.equal(estimateTokenCount("abc"), 1);
});

test("estimateTokenCount: ~4 chars per token", () => {
  assert.equal(estimateTokenCount("a".repeat(40)), 10);
  assert.equal(estimateTokenCount("a".repeat(16)), 4);
});

test("batched SSE delta estimate beats event-count of 1", () => {
  // vLLM often sends ~16 chars (≈4 tokens) in one delta
  const chars = "Invent many rows of JSON metrics data";
  const estimated = estimateTokenCount(chars);
  assert.ok(estimated > 1, `expected >1 tokens for ${chars.length} chars, got ${estimated}`);
  assert.equal(estimated, Math.round(chars.length / 4));
});

test("live decode rate formula matches final decodeTps shape", () => {
  // Same math ShowcaseManager / LlmStreaming use: (tokens-1) / (tLast-tFirst) * 1000
  const tokenCount = 100;
  const tFirst = 1000;
  const tLast = 5000; // 4s decode window
  const decodeTokens = Math.max(0, tokenCount - 1);
  const elapsedMs = tLast - tFirst;
  const live = round2((decodeTokens / elapsedMs) * 1000);
  assert.equal(live, 24.75);
});

test("promptTpsFromTtft: prompt tokens / TTFT", () => {
  assert.equal(promptTpsFromTtft(200, 100), 2000);
  assert.equal(promptTpsFromTtft(512, 256), 2000);
  assert.equal(promptTpsFromTtft(0, 100), 0);
  assert.equal(promptTpsFromTtft(100, 0), 0);
  assert.equal(promptTpsFromTtft(null, 50), 0);
});

function textRes(txt, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => txt,
    json: async () => ({}),
  };
}

function jsonRes(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

test("readServerTokenCounters: vLLM prompt + generation series", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/metrics")) {
      return textRes(
        `vllm:prompt_tokens_total{engine="0"} 1000.0\nvllm:generation_tokens_total{engine="0"} 500.0\n`
      );
    }
    return textRes("", 404);
  };
  try {
    const c = await readServerTokenCounters("http://10.0.0.1:8000");
    assert.equal(c.generation, 500);
    assert.equal(c.prompt, 1000);
    assert.equal(await readServerGenerationTokens("http://10.0.0.1:8000"), 500);
  } finally {
    globalThis.fetch = orig;
  }
});

test("readServerTokenCounters: ds4 prefilled + decoded", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/metrics")) {
      return textRes(
        `ds4_tokens_prefilled_total{kind="computed"} 100.0\nds4_tokens_prefilled_total{kind="cached"} 300.0\nds4_tokens_decoded_total 50.0\n`
      );
    }
    return textRes("", 404);
  };
  try {
    const c = await readServerTokenCounters("http://10.0.0.1:8888");
    assert.equal(c.generation, 50);
    assert.equal(c.prompt, 400);
  } finally {
    globalThis.fetch = orig;
  }
});

test("readServerTokenCounters: llama.cpp /slots", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/metrics")) return textRes("", 404);
    if (String(url).endsWith("/get_server_info")) return jsonRes({}, 404);
    if (String(url).endsWith("/slots")) {
      return jsonRes([
        { id: 0, n_decoded: 50, n_prompt_tokens_processed: 25, state: "idle" },
        { id: 1, n_decoded: 10, n_prompt_tokens_processed: 5, state: "idle" },
      ]);
    }
    return jsonRes({}, 404);
  };
  try {
    const c = await readServerTokenCounters("http://10.0.0.1:8080");
    assert.equal(c.generation, 60);
    assert.equal(c.prompt, 30);
  } finally {
    globalThis.fetch = orig;
  }
});
