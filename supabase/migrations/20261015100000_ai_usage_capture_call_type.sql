-- How this works: lets kelvo_ai_usage record "capture" calls, the AI allowance for
-- Tell Kelvo (POST /api/capture in Kelvo Home). canUseAiFeature counts capture calls
-- in their own monthly bucket (free 60, premium 300). Without this, logAiUsage's insert
-- of call_type 'capture' fails the check constraint and the call is never counted.
--
-- The same statement ships in kelvo-hub as 20261012100000_ai_usage_capture.sql; this
-- copy exists so the package's own migrations describe the table it checks. Run one of
-- the two in the Supabase SQL Editor (project bjpdnkjwjtlomyniawvj). Safe to run twice:
-- the constraint is dropped if it exists, then added again.

alter table public.kelvo_ai_usage
  drop constraint if exists kelvo_ai_usage_call_type_check;
alter table public.kelvo_ai_usage
  add constraint kelvo_ai_usage_call_type_check
  check (call_type in ('reflection', 'recap', 'insight', 'chat', 'capture'));

notify pgrst, 'reload schema';
