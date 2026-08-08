-- Link a Kelvo user to their Stripe customer, so the billing portal and
-- webhook handlers can look up subscription state in one direction and
-- update it in the other. Written from kelvo-hub, which owns the Stripe
-- integration, but this table itself stays suite-wide (see 001).
-- Run this once in the Supabase SQL Editor for the shared Kelvo project (bjpdnkjwjtlomyniawvj).

alter table public.kelvo_subscriptions
  add column if not exists stripe_customer_id text unique;

alter table public.kelvo_subscriptions
  add column if not exists stripe_subscription_id text unique;
