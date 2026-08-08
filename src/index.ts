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
// number — generous enough that a normal user never notices it, while still bounding worst-case
// per-subscriber API spend to something predictable.
export const PREMIUM_REFLECTION_LIMIT_PER_MONTH = 60;

// Recap/insight/chat calls pull more context (multiple days/entries) and cost meaningfully more
// per call than a single-entry reflection, so they share their own much smaller bucket. Free
// tier has zero access to this bucket, full stop — see isMultiEntry() below.
export const PREMIUM_MULTI_ENTRY_LIMIT_PER_MONTH = 4;
const MULTI_ENTRY_CALL_TYPES: CallType[] = ["recap", "insight", "chat"];

// Cross-user monitoring only (not enforced anywhere in code) — start conservative, raise once
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
  // payment provider webhook exists (a later build) — until then, "no row" must mean "not
  // paying," never the reverse.
  if (!data || data.status !== "premium") return "free";
  if (data.current_period_end && new Date(data.current_period_end) < new Date()) return "free";
  return "premium";
}

/**
 * Call this BEFORE making any server-side AI request, never after — see README.md for the
 * integration pattern every Kelvo app should follow when it adds an AI feature.
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
      // Premium hitting this at all is unusual — the distinct reason string lets you query
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
    // Never let usage-logging failures break the actual AI feature — just surface it in logs.
    console.error("kelvo-ai-limits: failed to log AI usage", error);
  }
}

/**
 * Cross-user monitoring only — requires a service-role client (bypasses RLS by design, since
 * this needs visibility across every user's rows, not just the caller's own). This never blocks
 * anything; it only logs when suite-wide daily call volume looks abnormal. The real hard spend
 * cap belongs in your AI provider's console, not here — see the constant's doc comment above.
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
      `kelvo-ai-limits: SAFETY NET — ${totalToday} AI calls today across all users, over the ${GLOBAL_DAILY_CALL_ALERT_THRESHOLD} alert threshold. Review usage and consider raising the threshold or investigating abuse.`
    );
  }
  return { totalToday, exceeded };
}
