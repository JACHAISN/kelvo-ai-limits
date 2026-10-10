// How this works: tests for the optional image input of generateWithGemini. Nothing here uses
// the network. We build the request body with buildGeminiRequest and check validateImages
// directly. The one test that calls generateWithGemini only uses bad images, which are refused
// before any fetch happens (and we swap fetch for a function that fails the test if called).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGeminiRequest,
  generateWithGemini,
  getSubscriptionTier,
  MAX_IMAGE_BYTES,
  requirePremium,
  validateImages,
} from "../src/index.ts";

// Tiny fake "files": just the real first bytes of each format, padded, as base64.
const jpeg = { mimeType: "image/jpeg", base64: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString("base64") };
const png = { mimeType: "image/png", base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64") };
const webp = {
  mimeType: "image/webp",
  base64: Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP")]).toString("base64"),
};

const base = { tier: "free" as const, systemPrompt: "sys", userContent: "what is on the plate?" };

test("text-only requests keep the old shape", () => {
  const { model, body } = buildGeminiRequest(base);
  assert.equal(model, "gemini-3-flash-preview");
  const contents = body.contents as any[];
  assert.deepEqual(contents[0].parts, [{ text: "what is on the plate?" }]);
  assert.deepEqual((body.generationConfig as any).thinkingConfig, { thinkingBudget: 0 });
  assert.equal((body.generationConfig as any).maxOutputTokens, 400);
});

test("images become inlineData parts before the text", () => {
  const { body } = buildGeminiRequest({ ...base, tier: "premium", images: [jpeg, png] });
  const parts = (body.contents as any[])[0].parts;
  assert.equal(parts.length, 3);
  assert.deepEqual(parts[0], { inlineData: { mimeType: "image/jpeg", data: jpeg.base64 } });
  assert.deepEqual(parts[1], { inlineData: { mimeType: "image/png", data: png.base64 } });
  assert.deepEqual(parts[2], { text: "what is on the plate?" });
});

test("an empty images array is the same as no images", () => {
  const { body } = buildGeminiRequest({ ...base, images: [] });
  assert.equal((body.contents as any[])[0].parts.length, 1);
});

test("jpeg, png and webp are accepted", () => {
  assert.equal(validateImages([jpeg]), null);
  assert.equal(validateImages([png, webp]), null);
  assert.equal(validateImages(undefined), null);
});

test("more than 2 images is refused", () => {
  assert.match(validateImages([jpeg, png, webp])!, /at most 2/);
});

test("other types, bad base64 and data: prefixes are refused", () => {
  assert.match(validateImages([{ mimeType: "image/gif", base64: jpeg.base64 }])!, /jpeg, png or webp/);
  assert.match(validateImages([{ mimeType: "image/jpeg", base64: "" }])!, /empty/);
  assert.match(validateImages([{ mimeType: "image/jpeg", base64: "data:image/jpeg;base64," + jpeg.base64 }])!, /plain base64/);
  assert.match(validateImages([{ mimeType: "image/jpeg", base64: "not base64!!" }])!, /plain base64/);
  assert.match(validateImages("nope"), /array/);
  assert.match(validateImages([null])!, /object/);
});

test("data that does not match its label is refused", () => {
  assert.match(validateImages([{ mimeType: "image/png", base64: jpeg.base64 }])!, /does not match/);
});

test("the 4 MB cap applies to the decoded size", () => {
  const header = Buffer.from([0xff, 0xd8, 0xff]);
  const atCap = Buffer.concat([header, Buffer.alloc(MAX_IMAGE_BYTES - header.length)]).toString("base64");
  const overCap = Buffer.concat([header, Buffer.alloc(MAX_IMAGE_BYTES - header.length + 1)]).toString("base64");
  assert.equal(validateImages([{ mimeType: "image/jpeg", base64: atCap }]), null);
  assert.match(validateImages([{ mimeType: "image/jpeg", base64: overCap }])!, /4 MB/);
});

test("buildGeminiRequest throws on bad images", () => {
  assert.throws(() => buildGeminiRequest({ ...base, images: [{ mimeType: "image/gif", base64: "AAAA" }] }));
});

test("generateWithGemini fails closed on bad images without calling the network", async () => {
  const realFetch = globalThis.fetch;
  const quiet = console.error;
  globalThis.fetch = (() => {
    throw new Error("fetch must not be called");
  }) as any;
  console.error = () => {};
  try {
    const result = await generateWithGemini({
      ...base,
      apiKey: "test-key",
      images: [{ mimeType: "image/gif", base64: "AAAA" }],
    });
    assert.equal(result.succeeded, false);
    assert.equal(result.content, null);
    assert.match(result.error!, /jpeg, png or webp/);
  } finally {
    globalThis.fetch = realFetch;
    console.error = quiet;
  }
});

function fakeSupabase(subscription: unknown): any {
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: () => Promise.resolve({ data: subscription, error: null }),
  };
  return { from: () => query };
}

test("requirePremium lets premium through and turns free users away", async () => {
  const premium = await requirePremium(fakeSupabase({ status: "premium", current_period_end: null }), "u");
  assert.deepEqual(premium, { ok: true, tier: "premium" });
  const free = await requirePremium(fakeSupabase(null), "u");
  assert.deepEqual(free, { ok: false, reason: "premium_required", tier: "free" });
  const expired = await requirePremium(fakeSupabase({ status: "premium", current_period_end: "2020-01-01T00:00:00Z" }), "u");
  assert.equal(expired.ok, false);
  assert.equal(await getSubscriptionTier(fakeSupabase(null), "u"), "free");
});
