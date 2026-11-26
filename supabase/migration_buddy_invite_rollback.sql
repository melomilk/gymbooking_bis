-- =====================================================================
-- UNDO migration_buddy_invite.sql. Run in the Supabase SQL Editor only if
-- something went wrong after that migration. One transaction.
--
-- Restores the previous versions of v_sessions, book_session(),
-- promote_waitlist(), join_waitlist() and my_points() (copied unchanged from
-- migration_session_cancel.sql, migration_waitlist.sql and
-- migration_points_rewards.sql) and removes everything the buddy migration
-- added, including the table buddy_invites with its invitations.
-- Kept on purpose: points already given as 'buddy_bonus' stay in the members'
-- balances, so points_ledger keeps allowing that reason.
-- =====================================================================

begin;

drop trigger if exists trg_buddy_on_attended       on public.bookings;
drop trigger if exists trg_buddy_on_booking_cancel on public.bookings;

create or replace view public.v_sessions as
select s.session_id, s.class_id, c.class_name, c.description, c.duration_min,
       s.trainer_id, t.trainer_name, s.branch_id, br.branch_name, s.room_id, r.room_name,
       s.start_time, s.end_time, s.capacity,
       (select count(*) from public.bookings b
         where b.session_id = s.session_id and b.booking_status <> 'Cancelled')::int as spots_taken,
       s.cancelled_at
from public.class_sessions s
join public.classes  c  on c.class_id   = s.class_id
join public.trainers t  on t.trainer_id = s.trainer_id
join public.branches br on br.branch_id = s.branch_id
join public.rooms    r  on r.room_id    = s.room_id;

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


drop view if exists public.v_my_buddy_invites;
drop table if exists public.buddy_invites;   -- also drops its own trigger
drop function if exists public.invite_buddy(bigint, text);
drop function if exists public.accept_buddy_invite(bigint);
drop function if exists public.decline_buddy_invite(bigint);
drop function if exists public.withdraw_buddy_invite(bigint);
drop function if exists public.expire_buddy_invites();
drop function if exists public.buddy_on_attended();
drop function if exists public.buddy_on_booking_cancel();
drop function if exists public.buddy_on_hold_released();
drop function if exists public.buddy_held_places(bigint);

commit;

notify pgrst, 'reload schema';
