-- Kelvo AI subscription state + usage tracking (shared across the whole suite)
-- Run this once in the Supabase SQL Editor for the shared Kelvo project (bjpdnkjwjtlomyniawvj).
-- These tables are suite-wide, not owned by any single app — keyed to the shared Kelvo user id.

create table if not exists public.kelvo_subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'free' check (status in ('free', 'premium')),
  premium_since timestamptz,
  current_period_end timestamptz,
  payment_provider text check (payment_provider in ('stripe', 'play_billing')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.kelvo_subscriptions enable row level security;

-- Read-only for users. Deliberately no insert/update/delete policy for the authenticated role —
-- writes only happen via the service_role key (which bypasses RLS entirely), e.g. from a future
-- Stripe/Play Billing webhook handler. A user with no row here is implicitly "free" — see
-- getTier() in kelvo-ai-limits, which treats a missing row as free tier rather than requiring
-- one to exist.
create policy "kelvo_subscriptions_select_own" on public.kelvo_subscriptions
  for select using (auth.uid() = user_id);

create table if not exists public.kelvo_ai_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  call_type text not null check (call_type in ('reflection', 'recap', 'insight', 'chat')),
  app text not null check (app in ('lifts', 'journal', 'habits', 'tasks', 'hub')),
  succeeded boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists kelvo_ai_usage_user_created_idx on public.kelvo_ai_usage (user_id, created_at desc);
-- Supports the cross-user daily safety-net check in checkGlobalDailySafetyNet().
create index if not exists kelvo_ai_usage_created_idx on public.kelvo_ai_usage (created_at desc);

alter table public.kelvo_ai_usage enable row level security;

-- Append-only from the calling user's own authenticated session — logging your own usage can't
-- hurt anyone but yourself, unlike subscription state. No update/delete policy: the log is
-- immutable once written.
create policy "kelvo_ai_usage_select_own" on public.kelvo_ai_usage
  for select using (auth.uid() = user_id);
create policy "kelvo_ai_usage_insert_own" on public.kelvo_ai_usage
  for insert with check (auth.uid() = user_id);
