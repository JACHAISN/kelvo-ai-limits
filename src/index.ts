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

// Sent back when the usage count itself could not be read (network blip, RLS problem, outage).
// The check fails closed: without a count there is no way to know the limit is not already used
// up, so the call is denied. Apps show USAGE_CHECK_FAILED_MESSAGE instead of an upgrade prompt,
// because this is not a limit the user has hit.
export const USAGE_CHECK_FAILED_REASON = "usage_check_failed";
export const USAGE_CHECK_FAILED_MESSAGE = "We couldn't check your AI usage just now. Please try again in a minute.";

function isMultiEntry(callType: CallType): boolean {
  return MULTI_ENTRY_CALL_TYPES.includes(callType);
}

// How many milliseconds the wall clock in `timeZone` is ahead of UTC at the instant `at`.
function zoneOffsetMs(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wallClockAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return wallClockAsUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The instant the current calendar month began for the user. With an IANA time zone (for
 * example "America/Denver", from the browser's Intl.DateTimeFormat().resolvedOptions().timeZone)
 * that is local midnight on the 1st, so a user's monthly allowance resets when their own month
 * turns over. With no time zone, or one Intl does not recognise, it falls back to the UTC month
 * start, which is what every caller got before the time zone parameter existed.
 */
export function currentCalendarMonthStart(timeZone?: string | null, now: Date = new Date()): string {
  if (timeZone) {
    try {
      const local = new Date(now.getTime() + zoneOffsetMs(timeZone, now));
      const firstAsUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1);
      // Subtract the offset in force at that midnight, then check once more in case a daylight
      // saving change sits between the guess and the real answer.
      let start = firstAsUtc - zoneOffsetMs(timeZone, new Date(firstAsUtc));
      start = firstAsUtc - zoneOffsetMs(timeZone, new Date(start));
      return new Date(start).toISOString();
    } catch {
      // Unknown time zone name: fall through to UTC rather than failing the AI feature.
    }
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/**
 * Looks up whether the user is on the free or premium tier. Exported so an app route can decide
 * things like "this feature is Premium only" before it spends any AI budget. A missing row,
 * a non-premium status, an expired period or a query error all count as "free".
 */
export async function getSubscriptionTier(supabase: SupabaseClient, userId: string): Promise<SubscriptionTier> {
  return getTier(supabase, userId);
}

/** The reason string a Premium-only route sends back to a free user. Show a calm upgrade message. */
export const PREMIUM_REQUIRED_REASON = "premium_required";

/**
 * Helper for Premium-only features (the Lifts food-photo scanner uses it). Call it first in the
 * route, before canUseAiFeature. Fails closed: if premium cannot be confirmed, the answer is no.
 */
export async function requirePremium(
  supabase: SupabaseClient,
  userId: string
): Promise<{ ok: true; tier: "premium" } | { ok: false; reason: typeof PREMIUM_REQUIRED_REASON; tier: "free" }> {
  const tier = await getTier(supabase, userId);
  if (tier === "premium") return { ok: true, tier: "premium" };
  return { ok: false, reason: PREMIUM_REQUIRED_REASON, tier: "free" };
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

function usageCheckFailed(tier: SubscriptionTier, error: unknown): UsageCheckResult {
  console.error("kelvo-ai-limits: usage count query failed, denying the call", error);
  return { allowed: false, reason: USAGE_CHECK_FAILED_REASON, remaining_this_period: null, tier };
}

/**
 * Call this BEFORE making any server-side AI request, never after (see README.md for the
 * integration pattern every Kelvo app should follow when it adds an AI feature).
 *
 * `timeZone` is optional: pass the user's IANA time zone so the monthly window starts at their
 * local month start. Leave it out and the window starts at the UTC month start.
 */
export async function canUseAiFeature(
  supabase: SupabaseClient,
  userId: string,
  callType: CallType,
  timeZone?: string | null
): Promise<UsageCheckResult> {
  const tier = await getTier(supabase, userId);
  const monthStart = currentCalendarMonthStart(timeZone);

  if (isMultiEntry(callType)) {
    if (tier === "free") {
      return { allowed: false, reason: "free_tier_no_multi_entry_access", remaining_this_period: 0, tier };
    }
    const { count, error } = await supabase
      .from("kelvo_ai_usage")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .in("call_type", MULTI_ENTRY_CALL_TYPES)
      .gte("created_at", monthStart);
    // An empty table is not an error: it comes back as count 0 with no error.
    if (error) return usageCheckFailed(tier, error);
    const used = count ?? 0;
    if (used >= PREMIUM_MULTI_ENTRY_LIMIT_PER_MONTH) {
      // Premium hitting this at all is unusual: the distinct reason string lets you query
      // kelvo_ai_usage for "premium_recap_limit_reached" events to review for bugs/abuse.
      return { allowed: false, reason: "premium_recap_limit_reached", remaining_this_period: 0, tier };
    }
    return { allowed: true, reason: null, remaining_this_period: PREMIUM_MULTI_ENTRY_LIMIT_PER_MONTH - used, tier };
  }

  const limit = tier === "premium" ? PREMIUM_REFLECTION_LIMIT_PER_MONTH : FREE_REFLECTION_LIMIT_PER_MONTH;
  const { count, error } = await supabase
    .from("kelvo_ai_usage")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("call_type", callType)
    .gte("created_at", monthStart);
  if (error) return usageCheckFailed(tier, error);
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

// --- Optional image input ---
// How this works: a caller (for example the Lifts food scanner) can pass up to 2 photos next to
// the text. Each photo is { mimeType, base64 } where base64 is the raw base64 text of the file
// (no "data:image/jpeg;base64," prefix). Everything is checked locally first, so a bad image
// never reaches the network. Gemini receives each photo as an "inlineData" part placed before
// the text, the documented REST shape: parts: [{ inlineData: { mimeType, data } }, { text }].
// Image calls count against the same usage bucket as text calls (call_type "reflection"): the
// caller still runs canUseAiFeature(..., "reflection", timeZone) and logAiUsage(...) as usual.

export const ALLOWED_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const MAX_IMAGES_PER_CALL = 2;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MB of decoded image data, per image

export interface GeminiImage {
  mimeType: string;
  base64: string;
}

// Size of the original file, worked out from the base64 text length without decoding it all.
function decodedByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

// The first bytes of a real jpeg, png or webp file. Stops data being labelled as the wrong type.
function matchesImageSignature(mimeType: string, base64: string): boolean {
  const head = Buffer.from(base64.slice(0, 24), "base64");
  if (mimeType === "image/jpeg") return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (mimeType === "image/png") {
    return head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  }
  if (mimeType === "image/webp") {
    return head.length >= 12 && head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP";
  }
  return false;
}

/** Returns null when the images are fine, or a short message saying what is wrong. */
export function validateImages(images: unknown): string | null {
  if (images === undefined) return null;
  if (!Array.isArray(images)) return "images must be an array";
  if (images.length > MAX_IMAGES_PER_CALL) return `at most ${MAX_IMAGES_PER_CALL} images are allowed`;
  for (const image of images) {
    if (!image || typeof image !== "object") return "each image must be an object";
    const { mimeType, base64 } = image as Partial<GeminiImage>;
    if (typeof mimeType !== "string" || !(ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) {
      return "image type must be jpeg, png or webp";
    }
    if (typeof base64 !== "string" || base64.length === 0) return "image data is empty";
    if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      return "image data must be plain base64 with no data: prefix";
    }
    if (decodedByteLength(base64) > MAX_IMAGE_BYTES) return "image is larger than 4 MB";
    if (!matchesImageSignature(mimeType, base64)) return "image data does not match its type";
  }
  return null;
}

export interface GenerateOptions {
  apiKey: string;
  tier: SubscriptionTier;
  systemPrompt: string;
  userContent: string;
  maxOutputTokens?: number;
  /** Optional photos, up to 2. Leave out for a normal text-only call. */
  images?: GeminiImage[];
}

export interface GenerateResult {
  content: string | null;
  succeeded: boolean;
  /** Only set when the call was refused before any network request (for example bad images). */
  error?: string;
}

/**
 * Builds the model name and JSON body for a Gemini request without sending anything, so tests
 * can check the exact request shape with no network. Throws if the images are invalid.
 */
export function buildGeminiRequest(options: Omit<GenerateOptions, "apiKey">): {
  model: string;
  body: Record<string, unknown>;
} {
  const imageError = validateImages(options.images);
  if (imageError) throw new Error(imageError);
  const model = options.tier === "premium" ? PREMIUM_TIER_MODEL : FREE_TIER_MODEL;
  const requestedMaxOutputTokens = options.maxOutputTokens ?? 400;
  // Pro can't turn thinking off (see below), and even at the lowest level it spends real tokens
  // reasoning before it answers: measured ~150 for a one-line reply, ~500 for a multi-source
  // reflection prompt (journal + workout + habits + tasks). Padding generously here keeps that
  // variance from eating into the actual response and truncating it; the cost difference is
  // negligible at Flash/Pro pricing.
  const maxOutputTokens = model === PREMIUM_TIER_MODEL ? requestedMaxOutputTokens + 700 : requestedMaxOutputTokens;

  // Photos go first, then the text.
  const parts: Record<string, unknown>[] = (options.images ?? []).map((image) => ({
    inlineData: { mimeType: image.mimeType, data: image.base64 },
  }));
  parts.push({ text: options.userContent });

  return {
    model,
    body: {
      systemInstruction: { parts: [{ text: options.systemPrompt }] },
      contents: [{ role: "user", parts }],
      generationConfig: {
        maxOutputTokens,
        // Flash tolerates disabling thinking outright, which avoids it eating the output
        // budget on a short direct task and risking a mid-sentence truncation. Pro rejects
        // thinkingBudget: 0 with a 400 ("this model only works in thinking mode"), so it gets
        // the lowest thinking level instead, the closest equivalent it actually supports.
        thinkingConfig: model === PREMIUM_TIER_MODEL ? { thinkingLevel: "LOW" } : { thinkingBudget: 0 },
      },
    },
  };
}

export async function generateWithGemini(options: GenerateOptions): Promise<GenerateResult> {
  // Invalid images fail closed here, before any network request. Image data is never logged.
  const imageError = validateImages(options.images);
  if (imageError) {
    console.error("kelvo-ai-limits: rejected images:", imageError);
    return { content: null, succeeded: false, error: imageError };
  }
  const { model, body } = buildGeminiRequest(options);

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": options.apiKey },
      body: JSON.stringify(body),
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
