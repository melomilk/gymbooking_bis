-- =====================================================================
-- PULSE POINTS AND REWARDS. Run ONCE in the Supabase SQL Editor, after the
-- other migrations, BEFORE migration_waitlist.sql and migration_reviews.sql. Purely additive:
-- no existing table, view or function is changed.
--
-- Points come only from real visits, so they can't be farmed by booking:
--   +10  attended class (NFC check-in or manual check-in at the front desk)
--   +20  every 4th week in a row with at least one attended class
--    +5  review of an attended class (migration_reviews.sql)
--    -5  no-show; given back if the no-show is excused or later checked in
-- A trigger on bookings writes these entries, so every existing function
-- (check_in_booking, manual_check_in, mark_no_shows, excuse_no_show) keeps
-- working as it is and points follow automatically.
--
-- Rewards are a catalog the admin edits. Kinds:
--   free_class        a free single visit / guest visit, issued at the front desk
--   late_cancel_pass  the next late cancellation is free (used automatically)
--   membership_days   the membership is extended by N days (applied at once)
--   merch             gym merchandise, handed out at the front desk
-- Each redemption gets a code like PG-7K3Q2A that the member shows at the desk.
-- =====================================================================

begin;

-- ---------- 1. Points ledger (append-only; balance = sum of delta) ----------
create table if not exists public.points_ledger (
  entry_id      bigint generated always as identity primary key,
  member_id     bigint not null references public.members(member_id) on delete cascade,
  delta         int not null check (delta <> 0),
  reason        varchar(20) not null check (reason in
                  ('attended', 'no_show', 'no_show_reversed', 'streak_bonus',
                   'review', 'review_removed', 'redeem', 'redeem_refund')),
  booking_id    bigint references public.bookings(booking_id) on delete set null,
  redemption_id bigint,
  week_start    date,          -- streak bonus: the week it was earned for
  created_at    timestamptz not null default now()
);
create index if not exists points_ledger_member on public.points_ledger (member_id, created_at);
-- one entry of each kind per booking (re-running a check-in can't add points twice)
create unique index if not exists points_ledger_once_per_booking on public.points_ledger (booking_id, reason)
  where booking_id is not null;
-- one streak bonus per member per week
create unique index if not exists points_ledger_once_per_week on public.points_ledger (member_id, week_start)
  where reason = 'streak_bonus';

-- ---------- 2. Rewards catalog ----------
create table if not exists public.rewards (
  reward_id    bigint generated always as identity primary key,
  reward_name  varchar(100) not null check (length(trim(reward_name)) > 0),
  description  varchar(300),
  kind         varchar(20) not null check (kind in ('free_class', 'late_cancel_pass', 'membership_days', 'merch')),
  cost         int not null check (cost between 1 and 100000),
  stock        int check (stock is null or stock >= 0),        -- null = unlimited
  extend_days  int check (extend_days is null or extend_days between 1 and 365),
  active       boolean not null default true,
  check (kind <> 'membership_days' or extend_days is not null)
);

create table if not exists public.reward_redemptions (
  redemption_id   bigint generated always as identity primary key,
  member_id       bigint not null references public.members(member_id) on delete cascade,
  reward_id       bigint not null references public.rewards(reward_id),
  cost            int not null,
  code            varchar(12) not null unique,
  status          varchar(10) not null default 'Active' check (status in ('Active', 'Used', 'Cancelled')),
  created_at      timestamptz not null default now(),
  used_at         timestamptz,
  used_by         bigint references public.members(member_id),
  used_booking_id bigint references public.bookings(booking_id) on delete set null,
  cancelled_at    timestamptz
);
create index if not exists reward_redemptions_member on public.reward_redemptions (member_id, created_at);

do $$ begin
  alter table public.points_ledger add constraint points_ledger_redemption_fk
    foreign key (redemption_id) references public.reward_redemptions(redemption_id) on delete set null;
exception when duplicate_object then null; end $$;

-- ---------- 3. Security: tables closed, reading via views, writing via functions ----------
alter table public.points_ledger      enable row level security;
alter table public.rewards            enable row level security;
alter table public.reward_redemptions enable row level security;
revoke all on public.points_ledger, public.reward_redemptions from anon, authenticated;
revoke all on public.rewards from anon;
-- the admin edits the catalog in the admin panel (same pattern as classes, rooms, ...)
grant select, insert, update, delete on public.rewards to authenticated;
drop policy if exists "rewards readable" on public.rewards;
create policy "rewards readable" on public.rewards for select to authenticated
  using (active or public.is_admin());
drop policy if exists "admin manages rewards" on public.rewards;
create policy "admin manages rewards" on public.rewards for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------- 4. Streak: weeks in a row (Asia/Almaty, Monday start) with an attended class ----------
-- The streak counts if the latest such week is this week or last week.
create or replace function public.attendance_streak(p_member_id bigint) returns int
language plpgsql stable security definer set search_path = public as $$
declare
  v_this     date := date_trunc('week', now() at time zone 'Asia/Almaty')::date;
  v_expected date;
  v_n        int := 0;
  r          record;
begin
  for r in
    select distinct date_trunc('week', s.start_time at time zone 'Asia/Almaty')::date as wk
      from public.bookings b
      join public.class_sessions s on s.session_id = b.session_id
     where b.member_id = p_member_id and b.booking_status = 'Attended'
     order by 1 desc
  loop
    if v_expected is null then
      if r.wk > v_this then continue; end if;
      if r.wk < v_this - 7 then return 0; end if;
      v_n := 1;
    elsif r.wk = v_expected then
      v_n := v_n + 1;
    else
      exit;
    end if;
    v_expected := r.wk - 7;
  end loop;
  return v_n;
end $$;
revoke all on function public.attendance_streak(bigint) from public, anon, authenticated;

-- ---------- 5. Points follow booking status changes ----------
create or replace function public.points_on_booking_status() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_streak int;
  v_week   date;
begin
  if new.booking_status is not distinct from old.booking_status then
    return null;
  end if;

  if new.booking_status = 'Attended' then
    insert into public.points_ledger (member_id, delta, reason, booking_id)
    values (new.member_id, 10, 'attended', new.booking_id)
    on conflict do nothing;

    -- streak bonus every 4th week in a row
    v_streak := public.attendance_streak(new.member_id);
    if v_streak > 0 and v_streak % 4 = 0 then
      select date_trunc('week', start_time at time zone 'Asia/Almaty')::date into v_week
        from public.class_sessions where session_id = new.session_id;
      insert into public.points_ledger (member_id, delta, reason, week_start)
      values (new.member_id, 20, 'streak_bonus', v_week)
      on conflict do nothing;
    end if;

  elsif new.booking_status = 'No-show' then
    insert into public.points_ledger (member_id, delta, reason, booking_id)
    values (new.member_id, -5, 'no_show', new.booking_id)
    on conflict do nothing;
  end if;

  -- a no-show that is excused (-> Cancelled) or checked in after all (-> Attended): give the 5 back
  if old.booking_status = 'No-show' and new.booking_status in ('Cancelled', 'Attended') then
    insert into public.points_ledger (member_id, delta, reason, booking_id)
    select new.member_id, 5, 'no_show_reversed', new.booking_id
     where exists (select 1 from public.points_ledger
                    where booking_id = new.booking_id and reason = 'no_show')
    on conflict do nothing;
  end if;
  return null;
end $$;

drop trigger if exists trg_points_on_booking_status on public.bookings;
create trigger trg_points_on_booking_status
after update of booking_status on public.bookings
for each row execute function public.points_on_booking_status();

-- ---------- 6. Late-cancel pass: used automatically on a late cancellation ----------
create or replace function public.use_late_cancel_pass() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_pass bigint;
begin
  if old.booking_status = 'Confirmed' and new.booking_status = 'Cancelled' and new.fee_forfeited then
    select r.redemption_id into v_pass
      from public.reward_redemptions r
      join public.rewards w on w.reward_id = r.reward_id
     where r.member_id = new.member_id and r.status = 'Active' and w.kind = 'late_cancel_pass'
     order by r.created_at
     limit 1
     for update of r;
    if found then
      new.fee_forfeited := false;
      update public.reward_redemptions
         set status = 'Used', used_at = now(), used_booking_id = new.booking_id
       where redemption_id = v_pass;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_use_late_cancel_pass on public.bookings;
create trigger trg_use_late_cancel_pass
before update of booking_status on public.bookings
for each row execute function public.use_late_cancel_pass();

-- ---------- 7. Views ----------
-- own points history (newest first) with what each entry was for
create or replace view public.v_my_points_history as
select l.entry_id, l.delta, l.reason, l.created_at, c.class_name, s.start_time, w.reward_name
from public.points_ledger l
join public.members m on m.member_id = l.member_id
left join public.bookings b on b.booking_id = l.booking_id
left join public.class_sessions s on s.session_id = b.session_id
left join public.classes c on c.class_id = s.class_id
left join public.reward_redemptions r on r.redemption_id = l.redemption_id
left join public.rewards w on w.reward_id = r.reward_id
where m.auth_user_id = auth.uid();

-- redemptions: own rows for members, all rows for staff (front desk hands out prizes)
create or replace view public.v_redemptions as
select r.redemption_id, r.member_id, m.member_name || ' ' || m.member_surname as member_fullname,
       m.phone_number, r.reward_id, w.reward_name, w.kind, w.extend_days, r.cost, r.code, r.status,
       r.created_at, r.used_at, r.cancelled_at
from public.reward_redemptions r
join public.members m on m.member_id = r.member_id
join public.rewards w on w.reward_id = r.reward_id
where m.auth_user_id = auth.uid() or public.is_staff();

revoke all on public.v_my_points_history, public.v_redemptions from anon;
grant select on public.v_my_points_history, public.v_redemptions to authenticated;

-- ---------- 8. Functions ----------
-- summary for the logged-in member
create or replace function public.my_points() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_member public.members%rowtype;
  v_month  timestamptz := (date_trunc('month', now() at time zone 'Asia/Almaty')) at time zone 'Asia/Almaty';
begin
  select * into v_member from public.members where auth_user_id = auth.uid();
  if not found then return null; end if;
  return jsonb_build_object(
    'balance',        coalesce((select sum(delta) from public.points_ledger where member_id = v_member.member_id), 0),
    'lifetime',       coalesce((select sum(delta) from public.points_ledger
                                 where member_id = v_member.member_id and reason in ('attended', 'streak_bonus', 'review')), 0),
    'month_points',   coalesce((select sum(delta) from public.points_ledger
                                 where member_id = v_member.member_id and created_at >= v_month
                                   and reason not in ('redeem', 'redeem_refund')), 0),
    'streak',         public.attendance_streak(v_member.member_id),
    'streak_bonuses', (select count(*) from public.points_ledger
                        where member_id = v_member.member_id and reason = 'streak_bonus'));
end $$;

-- monthly leaderboard: points earned this month (spending doesn't count),
-- only first name + surname initial are shown
create or replace function public.points_leaderboard(p_limit int default 10) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_month timestamptz := (date_trunc('month', now() at time zone 'Asia/Almaty')) at time zone 'Asia/Almaty';
  v_me    bigint;
begin
  select member_id into v_me from public.members where auth_user_id = auth.uid();
  return (
    with pts as (
      select l.member_id, sum(l.delta)::int as points
        from public.points_ledger l
       where l.created_at >= v_month and l.reason not in ('redeem', 'redeem_refund')
       group by l.member_id
      having sum(l.delta) > 0
    ), ranked as (
      select p.member_id, p.points, rank() over (order by p.points desc)::int as place,
             m.member_name || ' ' || left(m.member_surname, 1) || '.' as display_name
        from pts p join public.members m on m.member_id = p.member_id
       where m.role in ('Member', 'Trainer')
    )
    select jsonb_build_object(
      'top', coalesce((select jsonb_agg(jsonb_build_object('place', place, 'name', display_name,
                                'points', points, 'is_me', member_id = v_me) order by place, display_name)
                         from (select * from ranked order by place limit greatest(1, least(p_limit, 50))) t), '[]'::jsonb),
      'me',  (select jsonb_build_object('place', place, 'points', points) from ranked where member_id = v_me))
  );
end $$;

-- exchange points for a reward
create or replace function public.redeem_reward(p_reward_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_member  public.members%rowtype;
  v_reward  public.rewards%rowtype;
  v_balance int;
  v_code    text;
  v_id      bigint;
begin
  -- the member row is locked, so two parallel exchanges can't spend the same points
  select * into v_member from public.members where auth_user_id = auth.uid() for update;
  if not found then
    return public.result(false, 'not_signed_in', 'Please log in first.');
  end if;
  if v_member.role in ('Admin', 'Receptionist') then
    return public.result(false, 'staff_cannot_redeem', 'Staff accounts do not collect points.');
  end if;

  select * into v_reward from public.rewards where reward_id = p_reward_id for update;
  if not found or not v_reward.active then
    return public.result(false, 'reward_unavailable', 'This reward is not available.');
  end if;
  if v_reward.stock is not null and v_reward.stock <= 0 then
    return public.result(false, 'out_of_stock', 'This reward is out of stock.');
  end if;
  if v_reward.kind = 'late_cancel_pass' and exists (
       select 1 from public.reward_redemptions r join public.rewards w on w.reward_id = r.reward_id
        where r.member_id = v_member.member_id and r.status = 'Active' and w.kind = 'late_cancel_pass') then
    return public.result(false, 'pass_already_active', 'You already have an unused late-cancel pass.');
  end if;

  select coalesce(sum(delta), 0) into v_balance from public.points_ledger where member_id = v_member.member_id;
  if v_balance < v_reward.cost then
    return public.result(false, 'not_enough_points', 'Not enough points.');
  end if;

  loop  -- short code for the front desk, e.g. PG-7K3Q2A
    v_code := 'PG-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
    exit when not exists (select 1 from public.reward_redemptions where code = v_code);
  end loop;

  insert into public.reward_redemptions (member_id, reward_id, cost, code)
  values (v_member.member_id, v_reward.reward_id, v_reward.cost, v_code)
  returning redemption_id into v_id;
  insert into public.points_ledger (member_id, delta, reason, redemption_id)
  values (v_member.member_id, -v_reward.cost, 'redeem', v_id);
  if v_reward.stock is not null then
    update public.rewards set stock = stock - 1 where reward_id = v_reward.reward_id;
  end if;

  if v_reward.kind = 'membership_days' then   -- applied at once
    update public.members
       set membership_expiry = greatest(membership_expiry, current_date) + v_reward.extend_days
     where member_id = v_member.member_id;
    update public.reward_redemptions set status = 'Used', used_at = now() where redemption_id = v_id;
  end if;

  return public.result(true, 'redeemed', 'Reward received.') || jsonb_build_object('redemption_code', v_code);
end $$;

-- front desk: the member got the prize / used the free visit
create or replace function public.use_redemption(p_redemption_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_r    public.reward_redemptions%rowtype;
  v_kind text;
  v_me   bigint;
begin
  if not public.is_staff() then
    return public.result(false, 'staff_only', 'Only the front desk can do this.');
  end if;
  select * into v_r from public.reward_redemptions where redemption_id = p_redemption_id for update;
  if not found then
    return public.result(false, 'redemption_not_found', 'Reward not found.');
  end if;
  if v_r.status <> 'Active' then
    return public.result(false, 'redemption_not_active', 'This reward has already been used or cancelled.');
  end if;
  select kind into v_kind from public.rewards where reward_id = v_r.reward_id;
  if v_kind not in ('free_class', 'merch') then
    return public.result(false, 'redemption_auto', 'This reward is applied automatically.');
  end if;
  select member_id into v_me from public.members where auth_user_id = auth.uid();
  update public.reward_redemptions set status = 'Used', used_at = now(), used_by = v_me
   where redemption_id = p_redemption_id;
  return public.result(true, 'redemption_used', 'Marked as handed out.');
end $$;

-- cancel an unused reward: points and stock come back (member: own; staff: any)
create or replace function public.cancel_redemption(p_redemption_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_r public.reward_redemptions%rowtype;
begin
  select r.* into v_r from public.reward_redemptions r
    join public.members m on m.member_id = r.member_id
   where r.redemption_id = p_redemption_id and (m.auth_user_id = auth.uid() or public.is_staff())
   for update of r;
  if not found then
    return public.result(false, 'redemption_not_found', 'Reward not found.');
  end if;
  if v_r.status <> 'Active' then
    return public.result(false, 'redemption_not_active', 'This reward has already been used or cancelled.');
  end if;
  update public.reward_redemptions set status = 'Cancelled', cancelled_at = now()
   where redemption_id = p_redemption_id;
  insert into public.points_ledger (member_id, delta, reason, redemption_id)
  values (v_r.member_id, v_r.cost, 'redeem_refund', v_r.redemption_id);
  update public.rewards set stock = stock + 1 where reward_id = v_r.reward_id and stock is not null;
  return public.result(true, 'redemption_cancelled', 'Cancelled. The points are back.');
end $$;

revoke all on function public.my_points()                   from public, anon;
revoke all on function public.points_leaderboard(int)       from public, anon;
revoke all on function public.redeem_reward(bigint)         from public, anon;
revoke all on function public.use_redemption(bigint)        from public, anon;
revoke all on function public.cancel_redemption(bigint)     from public, anon;
grant execute on function public.my_points()                to authenticated;
grant execute on function public.points_leaderboard(int)    to authenticated;
grant execute on function public.redeem_reward(bigint)      to authenticated;
grant execute on function public.use_redemption(bigint)     to authenticated;
grant execute on function public.cancel_redemption(bigint)  to authenticated;

-- ---------- 9. Points for visits that happened before this migration ----------
insert into public.points_ledger (member_id, delta, reason, booking_id, created_at)
select b.member_id, 10, 'attended', b.booking_id, s.start_time
  from public.bookings b join public.class_sessions s on s.session_id = b.session_id
 where b.booking_status = 'Attended'
on conflict do nothing;
insert into public.points_ledger (member_id, delta, reason, booking_id, created_at)
select b.member_id, -5, 'no_show', b.booking_id, s.end_time
  from public.bookings b join public.class_sessions s on s.session_id = b.session_id
 where b.booking_status = 'No-show'
on conflict do nothing;

-- ---------- 10. Starter catalog (only if the catalog is empty; edit it in the admin panel) ----------
insert into public.rewards (reward_name, description, kind, cost, stock, extend_days)
select * from (values
  ('Late-cancel pass',      'Your next late cancellation is free of charge.',            'late_cancel_pass',  60, null::int, null::int),
  ('Free single visit',     'One extra class or a guest visit for a friend.',            'free_class',       150, null, null),
  ('PulseGym water bottle', 'Branded 0.7 l bottle. Pick it up at the front desk.',       'merch',            250,   30, null),
  ('+7 days of membership', 'Your membership is extended by 7 days right away.',         'membership_days',  300, null,    7),
  ('PulseGym towel',        'Branded sports towel. Pick it up at the front desk.',       'merch',            350,   20, null),
  ('PulseGym T-shirt',      'Branded training T-shirt. Pick it up at the front desk.',   'merch',            500,   15, null)
) v
where not exists (select 1 from public.rewards);

commit;
