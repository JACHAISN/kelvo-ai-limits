// How this works: plain Node tests, no test framework to install. Node 24 runs TypeScript
// directly, so `npm test` (node --test) loads src/index.ts as is. The Supabase client is a
// tiny fake that returns whatever count or error each test needs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { canUseAiFeature, currentCalendarMonthStart, USAGE_CHECK_FAILED_REASON } from "../src/index.ts";

test("month start defaults to UTC", () => {
  assert.equal(currentCalendarMonthStart(undefined, new Date("2026-11-01T03:00:00Z")), "2026-11-01T00:00:00.000Z");
  assert.equal(currentCalendarMonthStart(null, new Date("2026-11-01T03:00:00Z")), "2026-11-01T00:00:00.000Z");
});

test("month start follows the user's time zone, across daylight saving", () => {
  // 03:00 UTC on Nov 1 is still the evening of Oct 31 in Denver.
  assert.equal(currentCalendarMonthStart("America/Denver", new Date("2026-11-01T03:00:00Z")), "2026-10-01T06:00:00.000Z");
  assert.equal(currentCalendarMonthStart("America/Denver", new Date("2026-11-15T12:00:00Z")), "2026-11-01T06:00:00.000Z");
  assert.equal(currentCalendarMonthStart("America/Denver", new Date("2026-03-20T12:00:00Z")), "2026-03-01T07:00:00.000Z");
  assert.equal(currentCalendarMonthStart("Asia/Tokyo", new Date("2026-10-31T16:00:00Z")), "2026-10-31T15:00:00.000Z");
  assert.equal(currentCalendarMonthStart("Asia/Kolkata", new Date("2026-10-08T00:00:00Z")), "2026-09-30T18:30:00.000Z");
});

test("an unknown time zone falls back to UTC", () => {
  assert.equal(currentCalendarMonthStart("Not/AZone", new Date("2026-11-01T03:00:00Z")), "2026-11-01T00:00:00.000Z");
});

function fakeSupabase(subscription: unknown, usage: { count: number | null; error: unknown }): any {
  const query = {
    select: () => query,
    eq: () => query,
    in: () => query,
    gte: () => Promise.resolve(usage),
    maybeSingle: () => Promise.resolve({ data: subscription, error: null }),
  };
  return { from: () => query };
}
const premium = { status: "premium", current_period_end: null };

test("an empty usage table still allows the call", async () => {
  const result = await canUseAiFeature(fakeSupabase(null, { count: 0, error: null }), "u", "reflection");
  assert.equal(result.allowed, true);
  assert.equal(result.remaining_this_period, 5);
});

test("a usage query error denies the call (fails closed)", async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    const reflection = await canUseAiFeature(fakeSupabase(null, { count: null, error: { message: "down" } }), "u", "reflection");
    assert.equal(reflection.allowed, false);
    assert.equal(reflection.reason, USAGE_CHECK_FAILED_REASON);
    const recap = await canUseAiFeature(fakeSupabase(premium, { count: null, error: { message: "down" } }), "u", "recap");
    assert.equal(recap.allowed, false);
    assert.equal(recap.reason, USAGE_CHECK_FAILED_REASON);
  } finally {
    console.error = quiet;
  }
});

test("limits still apply", async () => {
  const recap = await canUseAiFeature(fakeSupabase(premium, { count: 4, error: null }), "u", "recap");
  assert.equal(recap.reason, "premium_recap_limit_reached");
  const free = await canUseAiFeature(fakeSupabase(null, { count: 5, error: null }), "u", "reflection", "America/Denver");
  assert.equal(free.reason, "free_tier_limit_reached");
});
