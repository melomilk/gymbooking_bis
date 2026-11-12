-- =====================================================================
-- SIGN-UP RATE LIMIT (run ONCE in Supabase SQL Editor, after
-- migration_trainer_signup.sql). Purely additive: existing tables,
-- views, functions and triggers are not changed.
--
-- Rule: at most N new accounts per rolling 60 seconds for the whole site
-- (default N = 150). Checked in two places:
--   1. signup_rate_status() - the app asks it before creating an account
--      and shows "try again in X seconds";
--   2. a BEFORE INSERT trigger on auth.users - the hard limit. Every way of
--      creating an account goes through it, so nobody can bypass the check
--      by calling Supabase directly.
--
-- Change the limit:  update public.signup_rate_limit set max_per_minute = 300;
-- Turn it off:        update public.signup_rate_limit set enabled = false;
-- =====================================================================

-- ---------- 1. Settings (exactly one row) ----------
create table if not exists public.signup_rate_limit (
  id              boolean primary key default true check (id),
  enabled         boolean not null default true,
  max_per_minute  int     not null default 150 check (max_per_minute > 0)
);
insert into public.signup_rate_limit (id) values (true) on conflict (id) do nothing;

-- ---------- 2. Log of recent sign-ups ----------
-- Only timestamps, no personal data. Rows older than 1 hour are removed
-- by the trigger itself, so the table stays tiny.
create table if not exists public.signup_events (
  event_id    bigint generated always as identity primary key,
  created_at  timestamptz not null default now()
);
create index if not exists signup_events_created_at on public.signup_events (created_at);

-- Nobody reads or writes these tables directly; only the functions below.
alter table public.signup_rate_limit enable row level security;
alter table public.signup_events     enable row level security;
revoke all on public.signup_rate_limit, public.signup_events from anon, authenticated;

-- ---------- 3. Status for the app ----------
-- {"allowed": true/false, "retry_after": seconds until a place frees up}
create or replace function public.signup_rate_status() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_cfg    public.signup_rate_limit%rowtype;
  v_count  int;
  v_oldest timestamptz;
begin
  select * into v_cfg from public.signup_rate_limit where id;
  if not found or not v_cfg.enabled then
    return jsonb_build_object('allowed', true, 'retry_after', 0);
  end if;

  select count(*) into v_count
    from public.signup_events where created_at > now() - interval '60 seconds';
  if v_count < v_cfg.max_per_minute then
    return jsonb_build_object('allowed', true, 'retry_after', 0);
  end if;

  -- the place frees up when the oldest of the last N events turns 60 s old
  select created_at into v_oldest
    from public.signup_events where created_at > now() - interval '60 seconds'
   order by created_at desc offset v_cfg.max_per_minute - 1 limit 1;
  return jsonb_build_object('allowed', false,
    'retry_after', greatest(1, ceil(extract(epoch from (v_oldest + interval '60 seconds' - now())))::int));
end $$;

revoke all on function public.signup_rate_status() from public;
grant execute on function public.signup_rate_status() to anon, authenticated, service_role;

-- ---------- 4. Hard limit on every new auth user ----------
create or replace function public.enforce_signup_rate_limit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_cfg   public.signup_rate_limit%rowtype;
  v_count int;
begin
  select * into v_cfg from public.signup_rate_limit where id;
  if not found or not v_cfg.enabled then
    return new;
  end if;

  -- one sign-up at a time is counted, so two parallel requests can't both
  -- take the last place (lock is released at the end of the transaction)
  perform pg_advisory_xact_lock(hashtext('signup_rate_limit'));

  delete from public.signup_events where created_at < now() - interval '1 hour';
  select count(*) into v_count
    from public.signup_events where created_at > now() - interval '60 seconds';
  if v_count >= v_cfg.max_per_minute then
    raise exception 'signup_rate_limited' using errcode = 'P0001';
  end if;

  -- if the account is not created after all, this row is rolled back with it
  insert into public.signup_events default values;
  return new;
end $$;

drop trigger if exists before_auth_user_rate_limit on auth.users;
create trigger before_auth_user_rate_limit
before insert on auth.users
for each row execute function public.enforce_signup_rate_limit();
