-- =====================================================================
-- "GOING WITH A FRIEND" (buddy invites). Run ONCE in the Supabase SQL Editor,
-- AFTER migration_session_cancel.sql, migration_points_rewards.sql and
-- migration_waitlist.sql. The whole file is one transaction: if anything
-- fails, nothing is changed. To undo it, run migration_buddy_invite_rollback.sql.
--
-- A member with a confirmed booking invites a friend by phone number. One
-- place in the class is HELD for the friend for 2 hours (never past the start).
-- The friend sees the invitation in My Profile once logged in with that phone
-- (a new person can register with it within the 2 hours) and accepts or
-- declines. If nobody answers, the hold ends by itself and the place is free
-- again (the waitlist gets it, if there is one).
-- When both bookings are checked in (NFC, or the front desk when the reader
-- fails), both members get +15 Pulse points ('buddy_bonus'), once.
--
-- What changes in existing objects (everything else is new):
--   * points_ledger.reason allows 'buddy_bonus'; my_points() counts it in the level
--   * a held place counts as taken: v_sessions.spots_taken, book_session(),
--     join_waitlist(), promote_waitlist(). Each is the latest version
--     (migration_session_cancel.sql / migration_waitlist.sql) plus that count.
-- No column of an existing table or view is added, removed or renamed.
-- =====================================================================

begin;

-- ---------- 0. The migrations this one builds on must be there ----------
do $$
begin
  if to_regclass('public.points_ledger') is null then
    raise exception 'Run migration_points_rewards.sql first';
  end if;
  if to_regprocedure('public.promote_waitlist(bigint)') is null then
    raise exception 'Run migration_waitlist.sql first';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'class_sessions' and column_name = 'cancelled_at') then
    raise exception 'Run migration_session_cancel.sql first';
  end if;
end $$;

-- ---------- 1. Table ----------
create table if not exists public.buddy_invites (
  invite_id          bigint generated always as identity primary key,
  inviter_id         bigint not null references public.members(member_id) on delete cascade,
  inviter_booking_id bigint not null references public.bookings(booking_id) on delete cascade,
  session_id         bigint not null references public.class_sessions(session_id),
  friend_phone       varchar(20) not null check (friend_phone ~ '^\+7[0-9]{10}$'),
  -- set when the friend accepts
  friend_member_id   bigint references public.members(member_id) on delete set null,
  friend_booking_id  bigint references public.bookings(booking_id) on delete set null,
  -- Pending = place held; Accepted = friend booked; the rest free the place
  status             varchar(10) not null default 'Pending'
                     check (status in ('Pending', 'Accepted', 'Declined', 'Withdrawn', 'Expired', 'Cancelled')),
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null,          -- end of the hold: 2 h, at most until the start
  responded_at       timestamptz,
  bonus_at           timestamptz,                   -- both came: +15 points each
  check (expires_at > created_at)
);
-- one friend per booking, and one invitation per phone and class at a time
create unique index if not exists buddy_one_per_booking on public.buddy_invites (inviter_booking_id)
  where status in ('Pending', 'Accepted');
create unique index if not exists buddy_one_per_phone on public.buddy_invites (session_id, friend_phone)
  where status in ('Pending', 'Accepted');
create index if not exists buddy_holds on public.buddy_invites (session_id) where status = 'Pending';
create index if not exists buddy_by_phone on public.buddy_invites (friend_phone);

alter table public.buddy_invites enable row level security;
revoke all on public.buddy_invites from anon, authenticated;   -- only through the view and functions below

-- ---------- 2. Points: new reason ----------
do $$
declare c text;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.points_ledger'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) like '%reason%'
  loop
    execute format('alter table public.points_ledger drop constraint %I', c);
  end loop;
end $$;
alter table public.points_ledger add constraint points_ledger_reason_check check (reason in
  ('attended', 'no_show', 'no_show_reversed', 'streak_bonus', 'review', 'review_removed',
   'redeem', 'redeem_refund', 'buddy_bonus'));

-- the level counts everything earned, so the buddy bonus too
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
                                 where member_id = v_member.member_id
                                   and reason in ('attended', 'streak_bonus', 'review', 'buddy_bonus')), 0),
    'month_points',   coalesce((select sum(delta) from public.points_ledger
                                 where member_id = v_member.member_id and created_at >= v_month
                                   and reason not in ('redeem', 'redeem_refund')), 0),
    'streak',         public.attendance_streak(v_member.member_id),
    'streak_bonuses', (select count(*) from public.points_ledger
                        where member_id = v_member.member_id and reason = 'streak_bonus'));
end $$;

-- ---------- 3. Held places ----------
-- Time decides: a Pending invite stops holding at expires_at even before
-- expire_buddy_invites() has marked it, so the count is always right.
create or replace function public.buddy_held_places(p_session_id bigint) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from public.buddy_invites
   where session_id = p_session_id and status = 'Pending' and expires_at > now()
$$;
revoke all on function public.buddy_held_places(bigint) from public, anon, authenticated;

-- schedule: same columns as before, a held place counts as taken
create or replace view public.v_sessions as
select s.session_id, s.class_id, c.class_name, c.description, c.duration_min,
       s.trainer_id, t.trainer_name, s.branch_id, br.branch_name, s.room_id, r.room_name,
       s.start_time, s.end_time, s.capacity,
       ((select count(*) from public.bookings b
          where b.session_id = s.session_id and b.booking_status <> 'Cancelled')
      + (select count(*) from public.buddy_invites i
          where i.session_id = s.session_id and i.status = 'Pending' and i.expires_at > now()))::int as spots_taken,
       s.cancelled_at
from public.class_sessions s
join public.classes  c  on c.class_id   = s.class_id
join public.trainers t  on t.trainer_id = s.trainer_id
join public.branches br on br.branch_id = s.branch_id
join public.rooms    r  on r.room_id    = s.room_id;

-- book_session: migration_session_cancel.sql version + held places in the count
create or replace function public.book_session(p_session_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_member   public.members%rowtype;
  v_session  public.class_sessions%rowtype;
  v_existing public.bookings%rowtype;
  v_has_old  boolean;
  v_taken    int;
begin
  -- the member row is locked too, so two parallel bookings of the same
  -- member can't both pass the time-conflict check below
  select * into v_member from public.members where auth_user_id = auth.uid() for update;
  if not found then
    return public.result(false, 'not_signed_in', 'Please log in to book a class.');
  end if;
  -- staff accounts run the gym; they don't book classes
  if v_member.role in ('Admin', 'Receptionist') then
    return public.result(false, 'staff_cannot_book', 'Staff accounts cannot book classes. Please use a member account.');
  end if;

  select * into v_session from public.class_sessions where session_id = p_session_id for update;
  if not found then
    return public.result(false, 'session_not_found', 'Class session not found.');
  end if;
  if v_session.cancelled_at is not null then
    return public.result(false, 'session_cancelled', 'This class has been cancelled.');
  end if;
  if v_session.start_time <= now() then
    return public.result(false, 'class_started', 'This class has already started.');
  end if;
  if v_member.membership_status = 'Suspended' then
    return public.result(false, 'membership_suspended', 'Your membership is suspended. Please contact the front desk.');
  end if;
  if v_member.membership_expiry < (v_session.start_time at time zone 'Asia/Almaty')::date then
    return public.result(false, 'membership_expired', 'Your membership expires before this class. Please renew it.');
  end if;

  select * into v_existing from public.bookings
   where member_id = v_member.member_id and session_id = p_session_id;
  v_has_old := found;   -- FOUND is reset by the next query
  if v_has_old and v_existing.booking_status <> 'Cancelled' then
    return public.result(false, 'already_booked', 'You have already booked this class');
  end if;

  -- a member can't be in two classes at the same time
  if exists (
    select 1
      from public.bookings b
      join public.class_sessions s on s.session_id = b.session_id
     where b.member_id = v_member.member_id
       and b.session_id <> p_session_id
       and b.booking_status in ('Confirmed', 'Attended')
       and tstzrange(s.start_time, s.end_time) && tstzrange(v_session.start_time, v_session.end_time)
  ) then
    return public.result(false, 'time_conflict', 'You already have another class booked at this time.');
  end if;

  select count(*) into v_taken from public.bookings
   where session_id = p_session_id and booking_status <> 'Cancelled';
  v_taken := v_taken + public.buddy_held_places(p_session_id);   -- places held for invited friends
  if v_taken >= v_session.capacity then
    return public.result(false, 'class_full', 'Class is full');
  end if;

  if v_has_old then   -- re-booking after a cancellation re-uses the row (UNIQUE rule)
    update public.bookings
       set booking_status = 'Confirmed', booking_time = now(), cancelled_at = null, fee_forfeited = false
     where booking_id = v_existing.booking_id;
  else
    insert into public.bookings (member_id, session_id) values (v_member.member_id, p_session_id);
  end if;
  return public.result(true, 'booked', 'Booking confirmed!');
exception when unique_violation then
  return public.result(false, 'already_booked', 'You have already booked this class');
end $$;

-- promote_waitlist: migration_waitlist.sql version + held places in the count
create or replace function public.promote_waitlist(p_session_id bigint) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_s      public.class_sessions%rowtype;
  v_e      public.waitlist%rowtype;
  v_m      public.members%rowtype;
  v_old    public.bookings%rowtype;
  v_taken  int;
  v_n      int := 0;
  v_reason text;
begin
  -- the same lock as book_session(), so the two can't hand out the same place
  select * into v_s from public.class_sessions where session_id = p_session_id for update;
  if not found then return 0; end if;

  if v_s.cancelled_at is not null then
    update public.waitlist set status = 'Expired', status_reason = 'session_cancelled', updated_at = now()
     where session_id = p_session_id and status = 'Waiting';
    return 0;
  end if;
  if v_s.start_time - now() < interval '3 hours' then
    return 0;   -- the queue is closed; entries show as expired in the views
  end if;

  loop
    select count(*) into v_taken from public.bookings
     where session_id = p_session_id and booking_status <> 'Cancelled';
    v_taken := v_taken + public.buddy_held_places(p_session_id);   -- a held place is not free
    exit when v_taken >= v_s.capacity;

    select * into v_e from public.waitlist
     where session_id = p_session_id and status = 'Waiting'
     order by created_at, entry_id
     limit 1
     for update skip locked;
    exit when not found;

    select * into v_m from public.members where member_id = v_e.member_id for update;
    v_reason := null;
    if v_m.membership_status = 'Suspended'
       or v_m.membership_expiry < (v_s.start_time at time zone 'Asia/Almaty')::date then
      v_reason := 'membership';
    elsif exists (
      select 1 from public.bookings b join public.class_sessions s on s.session_id = b.session_id
       where b.member_id = v_m.member_id and b.session_id <> p_session_id
         and b.booking_status in ('Confirmed', 'Attended')
         and tstzrange(s.start_time, s.end_time) && tstzrange(v_s.start_time, v_s.end_time)) then
      v_reason := 'time_conflict';
    end if;
    if v_reason is not null then   -- can't be booked: skip, the next person gets the place
      update public.waitlist set status = 'Expired', status_reason = v_reason, updated_at = now()
       where entry_id = v_e.entry_id;
      continue;
    end if;

    -- book (re-use a cancelled booking row: bookings are unique per member and class)
    select * into v_old from public.bookings where member_id = v_m.member_id and session_id = p_session_id;
    if found then
      if v_old.booking_status <> 'Cancelled' then   -- already has a place
        update public.waitlist set status = 'Promoted', booking_id = v_old.booking_id, updated_at = now()
         where entry_id = v_e.entry_id;
        continue;
      end if;
      update public.bookings
         set booking_status = 'Confirmed', booking_time = now(), cancelled_at = null, fee_forfeited = false
       where booking_id = v_old.booking_id;
    else
      insert into public.bookings (member_id, session_id) values (v_m.member_id, p_session_id)
      returning * into v_old;
    end if;
    update public.waitlist
       set status = 'Promoted', promoted_auto = true, booking_id = v_old.booking_id, updated_at = now()
     where entry_id = v_e.entry_id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
revoke all on function public.promote_waitlist(bigint) from public, anon, authenticated;

-- join_waitlist: migration_waitlist.sql version + held places in the count
create or replace function public.join_waitlist(p_session_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_m     public.members%rowtype;
  v_s     public.class_sessions%rowtype;
  v_taken int;
  v_pos   int;
begin
  select * into v_m from public.members where auth_user_id = auth.uid() for update;
  if not found then
    return public.result(false, 'not_signed_in', 'Please log in first.');
  end if;
  if v_m.role in ('Admin', 'Receptionist') then
    return public.result(false, 'staff_cannot_book', 'Staff accounts cannot book classes.');
  end if;
  select * into v_s from public.class_sessions where session_id = p_session_id for update;
  if not found then
    return public.result(false, 'session_not_found', 'Class session not found.');
  end if;
  if v_s.cancelled_at is not null then
    return public.result(false, 'session_cancelled', 'This class has been cancelled.');
  end if;
  if v_s.start_time - now() < interval '3 hours' then
    return public.result(false, 'waitlist_closed', 'The waitlist closes 3 hours before the class.');
  end if;
  if v_m.membership_status = 'Suspended' then
    return public.result(false, 'membership_suspended', 'Your membership is suspended.');
  end if;
  if v_m.membership_expiry < (v_s.start_time at time zone 'Asia/Almaty')::date then
    return public.result(false, 'membership_expired', 'Your membership expires before this class.');
  end if;
  if exists (select 1 from public.bookings where member_id = v_m.member_id and session_id = p_session_id
               and booking_status in ('Confirmed', 'Attended')) then
    return public.result(false, 'already_booked', 'You have already booked this class');
  end if;
  if exists (select 1 from public.waitlist where member_id = v_m.member_id and session_id = p_session_id
               and status = 'Waiting') then
    return public.result(false, 'already_waiting', 'You are already in the queue for this class.');
  end if;
  if exists (
    select 1 from public.bookings b join public.class_sessions s on s.session_id = b.session_id
     where b.member_id = v_m.member_id and b.booking_status in ('Confirmed', 'Attended')
       and tstzrange(s.start_time, s.end_time) && tstzrange(v_s.start_time, v_s.end_time)) then
    return public.result(false, 'time_conflict', 'You already have another class booked at this time.');
  end if;
  select count(*) into v_taken from public.bookings
   where session_id = p_session_id and booking_status <> 'Cancelled';
  v_taken := v_taken + public.buddy_held_places(p_session_id);
  if v_taken < v_s.capacity then
    return public.result(false, 'has_free_places', 'There are free places: just book the class.');
  end if;
  if (select count(*) from public.waitlist w join public.class_sessions s on s.session_id = w.session_id
       where w.member_id = v_m.member_id and w.status = 'Waiting' and s.start_time > now()) >= 5 then
    return public.result(false, 'waitlist_limit', 'You can wait for at most 5 classes at a time.');
  end if;

  insert into public.waitlist (session_id, member_id) values (p_session_id, v_m.member_id);
  select count(*) into v_pos from public.waitlist where session_id = p_session_id and status = 'Waiting';
  return public.result(true, 'waitlist_joined', 'You are in the queue.') || jsonb_build_object('position', v_pos);
exception when unique_violation then
  return public.result(false, 'already_waiting', 'You are already in the queue for this class.');
end $$;

-- ---------- 4. Triggers ----------
-- a hold ended (declined, withdrawn, expired, cancelled, accepted) -> the
-- waitlist may get the place, at the end of the transaction (like migration_waitlist.sql)
create or replace function public.buddy_on_hold_released() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    perform public.promote_waitlist(new.session_id);
  exception when others then
    raise warning 'waitlist promotion failed for session %: %', new.session_id, sqlerrm;
  end;
  return null;
end $$;

drop trigger if exists trg_buddy_on_hold_released on public.buddy_invites;
create constraint trigger trg_buddy_on_hold_released
after update of status on public.buddy_invites
deferrable initially deferred
for each row
when (old.status = 'Pending' and new.status <> 'Pending')
execute function public.buddy_on_hold_released();

-- the inviter cancelled (or the gym cancelled the class): the held place is released
create or replace function public.buddy_on_booking_cancel() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.buddy_invites set status = 'Cancelled', responded_at = now()
   where inviter_booking_id = new.booking_id and status = 'Pending';
  return null;
end $$;

drop trigger if exists trg_buddy_on_booking_cancel on public.bookings;
create trigger trg_buddy_on_booking_cancel
after update of booking_status on public.bookings
for each row
when (new.booking_status = 'Cancelled' and old.booking_status <> 'Cancelled')
execute function public.buddy_on_booking_cancel();

-- both came (both bookings Attended) -> +15 each, once per invitation
create or replace function public.buddy_on_attended() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_i public.buddy_invites%rowtype;
begin
  for v_i in
    select * from public.buddy_invites
     where status = 'Accepted' and bonus_at is null and friend_booking_id is not null
       and (inviter_booking_id = new.booking_id or friend_booking_id = new.booking_id)
     for update
  loop
    if exists (select 1 from public.bookings where booking_id = v_i.inviter_booking_id and booking_status = 'Attended')
       and exists (select 1 from public.bookings where booking_id = v_i.friend_booking_id and booking_status = 'Attended') then
      insert into public.points_ledger (member_id, delta, reason, booking_id)
      select b.member_id, 15, 'buddy_bonus', b.booking_id
        from public.bookings b
       where b.booking_id in (v_i.inviter_booking_id, v_i.friend_booking_id)
      on conflict do nothing;   -- unique (booking_id, reason): never twice
      update public.buddy_invites set bonus_at = now() where invite_id = v_i.invite_id;
    end if;
  end loop;
  return null;
end $$;

drop trigger if exists trg_buddy_on_attended on public.bookings;
create trigger trg_buddy_on_attended
after update of booking_status on public.bookings
for each row
when (new.booking_status = 'Attended' and old.booking_status <> 'Attended')
execute function public.buddy_on_attended();

-- ---------- 5. View: invitations I sent and invitations sent to my phone ----------
create or replace view public.v_my_buddy_invites as
select i.invite_id,
       case when im.auth_user_id = auth.uid() then 'sent' else 'received' end as direction,
       i.inviter_booking_id, i.session_id,
       case when im.auth_user_id = auth.uid() then i.friend_phone end as friend_phone,
       im.member_name || ' ' || left(im.member_surname, 1) || '.' as inviter_name,
       fm.member_name || ' ' || left(fm.member_surname, 1) || '.' as friend_name,
       case when i.status = 'Pending' and i.expires_at <= now() then 'Expired' else i.status end as status,
       i.created_at, i.expires_at, i.responded_at, i.friend_booking_id, i.bonus_at,
       c.class_name, t.trainer_name, br.branch_name, r.room_name, s.start_time, s.end_time
from public.buddy_invites i
join public.members im on im.member_id = i.inviter_id
left join public.members fm on fm.member_id = i.friend_member_id
join public.class_sessions s on s.session_id = i.session_id
join public.classes  c  on c.class_id   = s.class_id
join public.trainers t  on t.trainer_id = s.trainer_id
join public.branches br on br.branch_id = s.branch_id
join public.rooms    r  on r.room_id    = s.room_id
where im.auth_user_id = auth.uid()
   or i.friend_phone = (select me.phone_number from public.members me where me.auth_user_id = auth.uid());

revoke all on public.v_my_buddy_invites from anon;
grant select on public.v_my_buddy_invites to authenticated;

-- ---------- 6. Functions ----------
-- marks holds that ran out (only time decides, so anyone may call it; the app
-- calls it before reading invitations). Releasing them fills the waitlist.
create or replace function public.expire_buddy_invites() returns int
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  update public.buddy_invites set status = 'Expired'
   where status = 'Pending' and expires_at <= now();
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function public.invite_buddy(p_booking_id bigint, p_phone text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me     public.members%rowtype;
  v_b      public.bookings%rowtype;
  v_s      public.class_sessions%rowtype;
  v_friend public.members%rowtype;
  v_taken  int;
  v_until  timestamptz;
begin
  select * into v_me from public.members where auth_user_id = auth.uid() for update;
  if not found then
    return public.result(false, 'not_signed_in', 'Please log in first.');
  end if;
  if p_phone is null or p_phone !~ '^\+7[0-9]{10}$' then
    return public.result(false, 'invalid_phone', 'Enter a valid phone number.');
  end if;
  select * into v_b from public.bookings where booking_id = p_booking_id and member_id = v_me.member_id;
  if not found then
    return public.result(false, 'booking_not_found', 'Booking not found.');
  end if;
  if v_b.booking_status <> 'Confirmed' then
    return public.result(false, 'buddy_not_invitable', 'You can invite a friend only to a class you are booked for.');
  end if;
  -- the same lock as book_session(): the hold and a booking can't take the same last place
  select * into v_s from public.class_sessions where session_id = v_b.session_id for update;
  if v_s.cancelled_at is not null then
    return public.result(false, 'session_cancelled', 'This class has been cancelled.');
  end if;
  if v_s.start_time <= now() then
    return public.result(false, 'class_started', 'This class has already started.');
  end if;
  if p_phone = v_me.phone_number then
    return public.result(false, 'buddy_self', 'This is your own number.');
  end if;
  select * into v_friend from public.members where phone_number = p_phone;
  if found then
    if v_friend.role in ('Admin', 'Receptionist') then
      return public.result(false, 'buddy_staff', 'This number belongs to a staff account.');
    end if;
    if exists (select 1 from public.bookings where member_id = v_friend.member_id and session_id = v_s.session_id
                 and booking_status in ('Confirmed', 'Attended')) then
      return public.result(false, 'buddy_already_booked', 'Your friend is already booked for this class.');
    end if;
  end if;

  -- holds of this booking that ran out no longer block a new invitation
  update public.buddy_invites set status = 'Expired'
   where inviter_booking_id = p_booking_id and status = 'Pending' and expires_at <= now();
  if exists (select 1 from public.buddy_invites where inviter_booking_id = p_booking_id
               and status in ('Pending', 'Accepted')) then
    return public.result(false, 'buddy_already_invited', 'You have already invited a friend to this class.');
  end if;
  if (select count(*) from public.buddy_invites where inviter_id = v_me.member_id
       and status = 'Pending' and expires_at > now()) >= 3 then
    return public.result(false, 'buddy_limit', 'You can hold places for at most 3 friends at a time.');
  end if;

  select count(*) into v_taken from public.bookings
   where session_id = v_s.session_id and booking_status <> 'Cancelled';
  v_taken := v_taken + public.buddy_held_places(v_s.session_id);
  if v_taken >= v_s.capacity then
    return public.result(false, 'class_full', 'Class is full');
  end if;

  v_until := least(now() + interval '2 hours', v_s.start_time);
  insert into public.buddy_invites (inviter_id, inviter_booking_id, session_id, friend_phone, expires_at)
  values (v_me.member_id, p_booking_id, v_s.session_id, p_phone, v_until);
  return public.result(true, 'buddy_invited', 'A place is held for your friend.')
      || jsonb_build_object('expires_at', v_until);
exception when unique_violation then
  return public.result(false, 'buddy_friend_invited', 'This number already has an invitation to this class.');
end $$;

create or replace function public.accept_buddy_invite(p_invite_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me  public.members%rowtype;
  v_i   public.buddy_invites%rowtype;
  v_b   public.bookings%rowtype;
  v_res jsonb;
begin
  -- lock order as in book_session(): member, then session
  select * into v_me from public.members where auth_user_id = auth.uid() for update;
  if not found then
    return public.result(false, 'not_signed_in', 'Please log in first.');
  end if;
  select * into v_i from public.buddy_invites where invite_id = p_invite_id and friend_phone = v_me.phone_number;
  if not found then
    return public.result(false, 'invite_not_found', 'Invitation not found.');
  end if;
  perform 1 from public.class_sessions where session_id = v_i.session_id for update;
  select * into v_i from public.buddy_invites where invite_id = p_invite_id for update;
  if v_i.status <> 'Pending' then
    return public.result(false, 'invite_not_pending', 'This invitation is no longer open.');
  end if;
  if v_i.expires_at <= now() then
    update public.buddy_invites set status = 'Expired' where invite_id = p_invite_id;
    return public.result(false, 'invite_expired', 'The 2 hours are over: the place is no longer held.');
  end if;

  -- booked the class on their own in the meantime: just go together
  select * into v_b from public.bookings
   where member_id = v_me.member_id and session_id = v_i.session_id and booking_status in ('Confirmed', 'Attended');
  if found then
    update public.buddy_invites
       set status = 'Accepted', friend_member_id = v_me.member_id, friend_booking_id = v_b.booking_id, responded_at = now()
     where invite_id = p_invite_id;
    return public.result(true, 'buddy_accepted', 'You are going together!');
  end if;

  -- the held place becomes the friend's booking, with all the normal booking rules
  update public.buddy_invites set status = 'Accepted', friend_member_id = v_me.member_id, responded_at = now()
   where invite_id = p_invite_id;
  v_res := public.book_session(v_i.session_id);
  if not coalesce((v_res->>'ok')::boolean, false) then
    -- e.g. membership expired or time conflict: the place stays held, the friend can fix it and try again
    update public.buddy_invites set status = 'Pending', friend_member_id = null, responded_at = null
     where invite_id = p_invite_id;
    return v_res;
  end if;
  update public.buddy_invites
     set friend_booking_id = (select booking_id from public.bookings
                               where member_id = v_me.member_id and session_id = v_i.session_id)
   where invite_id = p_invite_id;
  return public.result(true, 'buddy_accepted', 'You are going together!');
end $$;

create or replace function public.decline_buddy_invite(p_invite_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  update public.buddy_invites i set status = 'Declined', responded_at = now()
   where i.invite_id = p_invite_id and i.status = 'Pending'
     and i.friend_phone = (select phone_number from public.members where auth_user_id = auth.uid());
  if not found then
    return public.result(false, 'invite_not_pending', 'This invitation is no longer open.');
  end if;
  return public.result(true, 'buddy_declined', 'Invitation declined. The place is free again.');
end $$;

create or replace function public.withdraw_buddy_invite(p_invite_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  update public.buddy_invites i set status = 'Withdrawn', responded_at = now()
    from public.members m
   where m.member_id = i.inviter_id and m.auth_user_id = auth.uid()
     and i.invite_id = p_invite_id and i.status = 'Pending';
  if not found then
    return public.result(false, 'invite_not_pending', 'This invitation is no longer open.');
  end if;
  return public.result(true, 'buddy_withdrawn', 'Invitation withdrawn. The place is free again.');
end $$;

revoke all on function public.expire_buddy_invites()                from public;
revoke all on function public.invite_buddy(bigint, text)            from public, anon;
revoke all on function public.accept_buddy_invite(bigint)           from public, anon;
revoke all on function public.decline_buddy_invite(bigint)          from public, anon;
revoke all on function public.withdraw_buddy_invite(bigint)         from public, anon;
revoke all on function public.buddy_on_hold_released()              from public, anon, authenticated;
revoke all on function public.buddy_on_booking_cancel()             from public, anon, authenticated;
revoke all on function public.buddy_on_attended()                   from public, anon, authenticated;
grant execute on function public.expire_buddy_invites()             to anon, authenticated;
grant execute on function public.invite_buddy(bigint, text)         to authenticated;
grant execute on function public.accept_buddy_invite(bigint)        to authenticated;
grant execute on function public.decline_buddy_invite(bigint)       to authenticated;
grant execute on function public.withdraw_buddy_invite(bigint)      to authenticated;

commit;

-- the API (PostgREST) sees the new view and functions at once
notify pgrst, 'reload schema';

-- Optional: if the pg_cron extension is enabled, free expired holds every 5 minutes
-- (without it they are freed when someone opens the site, which is enough):
-- select cron.schedule('expire-buddy-invites', '*/5 * * * *', 'select public.expire_buddy_invites()');
