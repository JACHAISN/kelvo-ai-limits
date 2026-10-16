// How this works: checks that generateWithGemini gives up on a hung request and that its logs
// never carry the user's text or Gemini's text. Nothing here uses the network: fetch is swapped
// for a function that only ends when the request's AbortSignal fires (a hung server), or that
// answers with a fixed body. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GEMINI_TIMEOUT_MS, generateWithGemini } from "../src/index.ts";

const base = { apiKey: "test-key", tier: "free" as const, systemPrompt: "sys", userContent: "SECRET NOTE from the user" };

function withFakes<T>(fetchImpl: typeof fetch, run: (logs: unknown[][]) => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  const realError = console.error;
  const logs: unknown[][] = [];
  globalThis.fetch = fetchImpl;
  console.error = (...args: unknown[]) => {
    logs.push(args);
  };
  return run(logs).finally(() => {
    globalThis.fetch = realFetch;
    console.error = realError;
  });
}

// A server that never answers: the promise only settles when the signal aborts it.
const hung: typeof fetch = (_url, init) =>
  new Promise((_, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

test("the default timeout is 25 seconds", () => {
  assert.equal(GEMINI_TIMEOUT_MS, 25000);
});

test("a hung request is abandoned and comes back as a failed result", async () => {
  await withFakes(hung, async (logs) => {
    const started = Date.now();
    const result = await generateWithGemini({ ...base, timeoutMs: 30 });
    assert.deepEqual(result, { content: null, succeeded: false });
    assert.ok(Date.now() - started < 5000, "did not wait for the full default timeout");
    assert.ok(logs.some((line) => String(line[0]).includes("timed out")), "the timeout is logged");
  });
});

test("the request carries an abort signal", async () => {
  let seen: AbortSignal | null | undefined;
  const capture: typeof fetch = async (_url, init) => {
    seen = init?.signal;
    return new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "ok" }] } }] }), {
      status: 200,
    });
  };
  await withFakes(capture, async () => {
    const result = await generateWithGemini(base);
    assert.equal(result.content, "ok");
    assert.ok(seen instanceof AbortSignal);
  });
});

test("logs never contain the user's text or Gemini's text", async () => {
  const truncated: typeof fetch = async () =>
    new Response(
      JSON.stringify({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "GEMINI REPLY about the SECRET NOTE" }] } }] }),
      { status: 200 }
    );
  await withFakes(truncated, async (logs) => {
    const result = await generateWithGemini(base);
    assert.equal(result.succeeded, false);
    const flat = JSON.stringify(logs);
    assert.ok(!flat.includes("SECRET NOTE"), "user text must not be logged");
    assert.ok(!flat.includes("GEMINI REPLY"), "model text must not be logged");
    assert.ok(flat.includes("MAX_TOKENS"), "the finish reason is logged");
  });
});

test("an error body is logged at most 200 characters long", async () => {
  const longBody = "x".repeat(1000) + " SECRET NOTE";
  const failing: typeof fetch = async () => new Response(longBody, { status: 500 });
  await withFakes(failing, async (logs) => {
    const result = await generateWithGemini(base);
    assert.equal(result.succeeded, false);
    const line = logs.find((l) => String(l[0]).includes("Gemini API error"));
    assert.ok(line);
    assert.equal(line[1], 500);
    assert.equal(String(line[2]).length, 200);
    assert.ok(!JSON.stringify(logs).includes("SECRET NOTE"));
  });
});
