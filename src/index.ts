import type { SupabaseClient } from "@supabase/supabase-js";

export type CallType = "reflection" | "recap" | "insight" | "chat";
export type AppName = "lifts" | "journal" | "habits" | "tasks" | "hub";
export type SubscriptionTier = "free" | "premium";

// --- Cap numbers, documented for future-me ---

// Free tier gets a "taste" of the single-entry reflection feature and nothing else. 5/month is
// low enough to cost very little even at zero conversions, high enough to actually experience
// the feature (roughly one a week).
export const FREE_REFLECTION_LIMIT_PER_MONTH = 5;

// Premium's 60/month (~2/day) is a soft ceiling, not something advertised to users as a hard
// number: generous enough that a normal user never notices it, while still bounding worst-case
// per-subscriber API spend to something predictable.
export const PREMIUM_REFLECTION_LIMIT_PER_MONTH = 60;

// Recap/insight/chat calls pull more context (multiple days/entries) and cost meaningfully more
// per call than a single-entry reflection, so they share their own much smaller bucket. Free
// tier has zero access to this bucket, full stop (see isMultiEntry() below).
export const PREMIUM_MULTI_ENTRY_LIMIT_PER_MONTH = 4;
const MULTI_ENTRY_CALL_TYPES: CallType[] = ["recap", "insight", "chat"];

// Cross-user monitoring only (not enforced anywhere in code): start conservative, raise once
// real usage data comes in. Set the actual hard spend cap in your AI provider's console itself
// (Anthropic/Gemini/OpenAI); this number is for noticing a problem, not preventing one.
export const GLOBAL_DAILY_CALL_ALERT_THRESHOLD = 200;

export interface UsageCheckResult {
  allowed: boolean;
  reason: string | null;
  remaining_this_period: number | null;
  tier: SubscriptionTier;
}

function isMultiEntry(callType: CallType): boolean {
  return MULTI_ENTRY_CALL_TYPES.includes(callType);
}

function currentCalendarMonthStart(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

async function getTier(supabase: SupabaseClient, userId: string): Promise<SubscriptionTier> {
  const { data } = await supabase
    .from("kelvo_subscriptions")
    .select("status, current_period_end")
    .eq("user_id", userId)
    .maybeSingle();

  // Absence of a row means free tier by default. Subscription rows only get created once a
  // payment provider webhook exists (a later build). Until then, "no row" must mean "not
  // paying," never the reverse.
  if (!data || data.status !== "premium") return "free";
  if (data.current_period_end && new Date(data.current_period_end) < new Date()) return "free";
  return "premium";
}

/**
 * Call this BEFORE making any server-side AI request, never after (see README.md for the
 * integration pattern every Kelvo app should follow when it adds an AI feature).
 */
export async function canUseAiFeature(
  supabase: SupabaseClient,
  userId: string,
  callType: CallType
): Promise<UsageCheckResult> {
  const tier = await getTier(supabase, userId);
  const monthStart = currentCalendarMonthStart();

  if (isMultiEntry(callType)) {
    if (tier === "free") {
      return { allowed: false, reason: "free_tier_no_multi_entry_access", remaining_this_period: 0, tier };
    }
    const { count } = await supabase
      .from("kelvo_ai_usage")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .in("call_type", MULTI_ENTRY_CALL_TYPES)
      .gte("created_at", monthStart);
    const used = count ?? 0;
    if (used >= PREMIUM_MULTI_ENTRY_LIMIT_PER_MONTH) {
      // Premium hitting this at all is unusual: the distinct reason string lets you query
      // kelvo_ai_usage for "premium_recap_limit_reached" events to review for bugs/abuse.
      return { allowed: false, reason: "premium_recap_limit_reached", remaining_this_period: 0, tier };
    }
    return { allowed: true, reason: null, remaining_this_period: PREMIUM_MULTI_ENTRY_LIMIT_PER_MONTH - used, tier };
  }

  const limit = tier === "premium" ? PREMIUM_REFLECTION_LIMIT_PER_MONTH : FREE_REFLECTION_LIMIT_PER_MONTH;
  const { count } = await supabase
    .from("kelvo_ai_usage")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("call_type", callType)
    .gte("created_at", monthStart);
  const used = count ?? 0;
  if (used >= limit) {
    return {
      allowed: false,
      reason: tier === "premium" ? "premium_reflection_limit_reached" : "free_tier_limit_reached",
      remaining_this_period: 0,
      tier,
    };
  }
  return { allowed: true, reason: null, remaining_this_period: limit - used, tier };
}

/**
 * Log every AI call attempt, including ones that errored out after already consuming tokens.
 * Call this immediately after the AI provider responds (success or failure), not before.
 */
export async function logAiUsage(
  supabase: SupabaseClient,
  userId: string,
  callType: CallType,
  app: AppName,
  succeeded: boolean
): Promise<void> {
  const { error } = await supabase
    .from("kelvo_ai_usage")
    .insert({ user_id: userId, call_type: callType, app, succeeded });
  if (error) {
    // Never let usage-logging failures break the actual AI feature. Just surface it in logs.
    console.error("kelvo-ai-limits: failed to log AI usage", error);
  }
}

/**
 * Cross-user monitoring only: requires a service-role client (bypasses RLS by design, since
 * this needs visibility across every user's rows, not just the caller's own). This never blocks
 * anything; it only logs when suite-wide daily call volume looks abnormal. The real hard spend
 * cap belongs in your AI provider's console, not here (see the constant's doc comment above).
 */
export async function checkGlobalDailySafetyNet(
  serviceRoleClient: SupabaseClient
): Promise<{ totalToday: number; exceeded: boolean }> {
  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();

  const { count } = await serviceRoleClient
    .from("kelvo_ai_usage")
    .select("id", { count: "exact", head: true })
    .gte("created_at", dayStart);

  const totalToday = count ?? 0;
  const exceeded = totalToday > GLOBAL_DAILY_CALL_ALERT_THRESHOLD;
  if (exceeded) {
    console.error(
      `kelvo-ai-limits: SAFETY NET: ${totalToday} AI calls today across all users, over the ${GLOBAL_DAILY_CALL_ALERT_THRESHOLD} alert threshold. Review usage and consider raising the threshold or investigating abuse.`
    );
  }
  return { totalToday, exceeded };
}

// --- Shared Gemini calling logic ---
// Every app in the suite generates short factual-summary-to-text completions the same way, so
// the actual provider call lives here too, not just the rate limiting. Model selection by tier
// is centralized here specifically so every app's AI feature automatically gets the
// free-Flash/premium-Pro quality split without each app hardcoding model names.

// "Preview" models can change or get pulled without much notice, and Google renames Gemini
// models more often than most providers. If either of these starts 404ing, check
// https://ai.google.dev/gemini-api/docs/models for current names and update here (once, for
// every app, instead of in five places). gemini-3-pro-preview was shut down 2026-03-09;
// gemini-3.1-pro-preview is its replacement.
const FREE_TIER_MODEL = "gemini-3-flash-preview";
const PREMIUM_TIER_MODEL = "gemini-3.1-pro-preview";

export interface GenerateOptions {
  apiKey: string;
  tier: SubscriptionTier;
  systemPrompt: string;
  userContent: string;
  maxOutputTokens?: number;
}

export interface GenerateResult {
  content: string | null;
  succeeded: boolean;
}

export async function generateWithGemini(options: GenerateOptions): Promise<GenerateResult> {
  const model = options.tier === "premium" ? PREMIUM_TIER_MODEL : FREE_TIER_MODEL;
  const maxOutputTokens = options.maxOutputTokens ?? 400;

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": options.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: options.systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: options.userContent }] }],
        generationConfig: {
          maxOutputTokens,
          // Flash tolerates disabling thinking outright, which avoids it eating the output
          // budget on a short direct task and risking a mid-sentence truncation. Pro rejects
          // thinkingBudget: 0 with a 400 ("this model only works in thinking mode"), so it gets
          // the lowest thinking level instead, the closest equivalent it actually supports.
          thinkingConfig: model === PREMIUM_TIER_MODEL ? { thinkingLevel: "LOW" } : { thinkingBudget: 0 },
        },
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.error("kelvo-ai-limits: Gemini API error", res.status, errBody);
      return { content: null, succeeded: false };
    }

    const data = await res.json();
    const candidate = data.candidates?.[0];
    const finishReason = candidate?.finishReason;
    const text: string | undefined = candidate?.content?.parts?.[0]?.text?.trim();

    if (finishReason && finishReason !== "STOP") {
      // MAX_TOKENS (truncated mid-response), SAFETY, etc.: never return a broken/partial
      // response as if it were a real one.
      console.error("kelvo-ai-limits: Gemini response did not finish normally", finishReason, text);
      return { content: null, succeeded: false };
    }

    return { content: text ?? null, succeeded: Boolean(text) };
  } catch (err) {
    console.error("kelvo-ai-limits: Gemini call threw", err);
    return { content: null, succeeded: false };
  }
}
