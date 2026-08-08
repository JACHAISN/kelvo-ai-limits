# kelvo-ai-limits

Shared subscription state + AI rate-limiting layer for the Kelvo suite (Lifts, Journal, Habits,
Tasks, Kelvo hub, and anything added later). Built once here so no app duplicates this logic —
every app that adds an AI feature imports this package and calls it the same way.

No secrets live in this package. Each app supplies its own authenticated Supabase client.

## Setup (once per Supabase project)

Run `supabase/migrations/001_kelvo_subscriptions_and_ai_usage.sql` in the Supabase SQL Editor.
This only needs to happen once for the whole shared project — not per app.

## Installing in an app

```json
// package.json
"dependencies": {
  "kelvo-ai-limits": "github:JACHAISN/kelvo-ai-limits"
}
```

```ts
// next.config.ts — required so Next.js transpiles this package's raw TypeScript source
const nextConfig: NextConfig = {
  transpilePackages: ["kelvo-ai-limits"],
};
```

## Integration pattern

Call `canUseAiFeature` **before** making the AI provider request, and `logAiUsage`
**immediately after** it responds — success or failure, since a failed call can still have
consumed tokens.

```ts
// app/api/some-ai-feature/route.ts
import { canUseAiFeature, logAiUsage } from "kelvo-ai-limits";

export async function POST(req: NextRequest) {
  const supabase = serverSupabase(accessToken); // authenticated as the requesting user
  const userId = /* from supabase.auth.getUser() */;

  const check = await canUseAiFeature(supabase, userId, "reflection");
  if (!check.allowed) {
    return NextResponse.json(
      { error: check.reason, remaining_this_period: check.remaining_this_period, tier: check.tier },
      { status: 402 } // Payment Required — matches the paywall semantics
    );
  }

  let succeeded = false;
  try {
    const result = await callYourAiProvider(/* ... */);
    succeeded = true;
    return NextResponse.json({ content: result });
  } finally {
    // Fire-and-forget is fine here — don't let logging failures block the response.
    logAiUsage(supabase, userId, "reflection", "habits", succeeded);
  }
}
```

## Call types

- `"reflection"` — single-entry, cheap. Free tier gets `FREE_REFLECTION_LIMIT_PER_MONTH` (5/mo).
  Premium gets `PREMIUM_REFLECTION_LIMIT_PER_MONTH` (60/mo, a soft ceiling — don't advertise this
  number to users as a hard cap).
- `"recap"` / `"insight"` / `"chat"` — multi-entry, pulls more context, costs more per call.
  **Free tier has zero access to these**, full stop. Premium shares
  `PREMIUM_MULTI_ENTRY_LIMIT_PER_MONTH` (4/mo) across all three call types combined.

If your app needs a genuinely new call type, add it to the `CallType` union in `src/index.ts`
and decide whether it belongs in the cheap single-entry bucket or the multi-entry bucket — don't
invent a third bucket without updating this README.

## Adding your app

Add your app's short name to the `AppName` union in `src/index.ts` and to the `app` check
constraint in the migration, if it isn't already there (`lifts`, `journal`, `habits`, `tasks`,
`hub` are already covered).

## What this package does NOT do

- No payment processing (Stripe / Google Play Billing). This is subscription **state**
  management only — something else (a webhook handler, built separately) is responsible for
  writing to `kelvo_subscriptions`, using the service-role key, once a payment succeeds.
- No hard spend-cap enforcement. `checkGlobalDailySafetyNet` only logs when suite-wide daily
  volume looks abnormal — set your actual hard spend limit in your AI provider's console.
