# kelvo-ai-limits

Shared subscription state + AI rate-limiting layer for the Kelvo suite (Lifts, Journal, Habits,
Tasks, Kelvo hub, and anything added later). Built once here so no app duplicates this logic:
every app that adds an AI feature imports this package and calls it the same way.

No secrets live in this package. Each app supplies its own authenticated Supabase client.

## Setup (once per Supabase project)

Run `supabase/migrations/001_kelvo_subscriptions_and_ai_usage.sql` in the Supabase SQL Editor.
This only needs to happen once for the whole shared project, not per app.

## Installing in an app

```json
// package.json
"dependencies": {
  "kelvo-ai-limits": "github:JACHAISN/kelvo-ai-limits"
}
```

```ts
// next.config.ts: required so Next.js transpiles this package's raw TypeScript source
const nextConfig: NextConfig = {
  transpilePackages: ["kelvo-ai-limits"],
};
```

## Integration pattern

Call `canUseAiFeature` **before** making the AI provider request, `generateWithGemini` to
actually make it (this also picks the right model for the user's tier: Flash for free, Pro for
premium, so every app gets that quality split for free), and `logAiUsage` **immediately after**
it responds (success or failure), since a failed call can still have consumed tokens.

```ts
// app/api/some-ai-feature/route.ts
import { canUseAiFeature, generateWithGemini, logAiUsage } from "kelvo-ai-limits";

export async function POST(req: NextRequest) {
  const supabase = serverSupabase(accessToken); // authenticated as the requesting user
  const userId = /* from supabase.auth.getUser() */;

  const check = await canUseAiFeature(supabase, userId, "reflection");
  if (!check.allowed) {
    return NextResponse.json(
      { error: check.reason, remaining_this_period: check.remaining_this_period, tier: check.tier },
      { status: 402 } // Payment Required: matches the paywall semantics
    );
  }

  const result = await generateWithGemini({
    apiKey: process.env.GEMINI_API_KEY!,
    tier: check.tier,
    systemPrompt: "...",
    userContent: "...", // your app's own factual summary of whatever it's reflecting on
  });

  // Fire-and-forget is fine here: don't let logging failures block the response.
  logAiUsage(supabase, userId, "reflection", "habits", result.succeeded);

  if (!result.content) {
    return NextResponse.json({ error: "Failed to generate. Try again." }, { status: 502 });
  }
  return NextResponse.json({ content: result.content });
}
```

You don't have to use `generateWithGemini`: any provider works as long as you still call
`canUseAiFeature` first and `logAiUsage` after. But reusing it means model-tier upgrades,
thinking-token fixes, and truncation handling only ever need fixing in one place.

## Photos (optional image input)

`generateWithGemini` takes an optional `images` array for features like the Lifts food scanner.
Each item is `{ mimeType, base64 }`: plain base64 with no `data:` prefix. Limits: at most 2
images, 4 MB each (decoded size), `image/jpeg`, `image/png` or `image/webp` only, and the bytes
must really be that format. Anything else is refused before any network call and comes back as
`{ content: null, succeeded: false, error: "..." }`. Photos are sent to Gemini as inline data and
are never stored or logged by this package.

Photo calls use the same `reflection` usage bucket as text calls, so the route is the same:
`canUseAiFeature(supabase, userId, "reflection", timeZone)` first, `logAiUsage(...)` after.
For a Premium-only feature, call `requirePremium(supabase, userId)` before that. It returns
`{ ok: true, tier }` or `{ ok: false, reason: "premium_required", tier: "free" }`, and fails closed.
`getSubscriptionTier` is also exported if you just need the tier.

```ts
const gate = await requirePremium(supabase, userId);
if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: 402 });
const check = await canUseAiFeature(supabase, userId, "reflection", timeZone);
if (!check.allowed) return NextResponse.json({ error: check.reason }, { status: 402 });
const result = await generateWithGemini({
  apiKey: process.env.GEMINI_API_KEY!,
  tier: check.tier,
  systemPrompt: "...",
  userContent: "Estimate the food in this photo.",
  images: [{ mimeType: "image/jpeg", base64 }],
});
logAiUsage(supabase, userId, "reflection", "lifts", result.succeeded);
```

`validateImages(images)` and `buildGeminiRequest(options)` are exported too, for checking input
early and for tests that must not use the network.

## Monthly window and time zones

Limits count calls since the start of the current calendar month. Pass the user's IANA time
zone as the optional fourth argument and the month starts at their local midnight on the 1st:

```ts
// The browser knows it: Intl.DateTimeFormat().resolvedOptions().timeZone, e.g. "America/Denver".
const check = await canUseAiFeature(supabase, userId, "reflection", timeZone);
```

Leave it out (or pass an unknown name) and the month starts at midnight UTC, as before.

## When the usage check fails

If the `kelvo_ai_usage` count query errors, the check **fails closed**: `allowed` is false and
`reason` is `usage_check_failed` (exported as `USAGE_CHECK_FAILED_REASON`). This is not a limit
the user hit, so show `USAGE_CHECK_FAILED_MESSAGE` ("try again in a minute") rather than an
upgrade prompt. An empty usage table is not an error and still allows the call.

## Tests

`npm test` runs `test/limits.test.ts` with Node's built-in runner (Node 24 runs TypeScript
directly, nothing to install).

## Call types

- `"reflection"`: single-entry, cheap. Free tier gets `FREE_REFLECTION_LIMIT_PER_MONTH` (5/mo).
  Premium gets `PREMIUM_REFLECTION_LIMIT_PER_MONTH` (60/mo, a soft ceiling, so don't advertise this
  number to users as a hard cap).
- `"recap"` / `"insight"` / `"chat"`: multi-entry, pulls more context, costs more per call.
  **Free tier has zero access to these**, full stop. Premium shares
  `PREMIUM_MULTI_ENTRY_LIMIT_PER_MONTH` (4/mo) across all three call types combined.
- `"capture"`: Tell Kelvo (one sentence filed into tasks, habits, lifts and journal). Its own
  bucket: free `FREE_CAPTURE_LIMIT_PER_MONTH` (60/mo), premium `PREMIUM_CAPTURE_LIMIT_PER_MONTH`
  (300/mo). Limit reasons are `free_tier_capture_limit_reached` and `premium_capture_limit_reached`.
  The `kelvo_ai_usage` check constraint must allow `'capture'` (migration in kelvo-hub,
  `20261012100000_ai_usage_capture.sql`).

If your app needs a genuinely new call type, add it to the `CallType` union in `src/index.ts`
and decide whether it belongs in the cheap single-entry bucket or the multi-entry bucket. Don't
invent a third bucket without updating this README.

## Adding your app

Add your app's short name to the `AppName` union in `src/index.ts` and to the `app` check
constraint in the migration, if it isn't already there (`lifts`, `journal`, `habits`, `tasks`,
`hub` are already covered).

## What this package does NOT do

- No payment processing (Stripe / Google Play Billing). This is subscription **state**
  management only: something else (a webhook handler, built separately) is responsible for
  writing to `kelvo_subscriptions`, using the service-role key, once a payment succeeds.
- No hard spend-cap enforcement. `checkGlobalDailySafetyNet` only logs when suite-wide daily
  volume looks abnormal, so set your actual hard spend limit in your AI provider's console.
