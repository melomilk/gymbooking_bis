-- =====================================================================
-- Booking and check-in rules (fixes from the manual test table, cases 1-5).
-- Run ONCE in the Supabase SQL editor on the deployed database.
-- New databases made from schema.sql already have these rules.
--
--   book_session():
--     * Admin and Receptionist accounts can't book classes (test case 5)
--     * a member can't book two classes that overlap in time (test case 3)
--   check_in_booking():
--     * the NFC check-in opens only 30 minutes before the class starts,
--       so a future class can't show as "Attended" (test cases 2 and 4)
--
-- Test case 1 (confirm a booking less than 3 hours before the start) is a
-- web-app change only; nothing to run for it here.
-- =====================================================================

begin;

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

create or replace function public.check_in_booking(p_booking_id bigint, p_reader_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_b      public.bookings%rowtype;
  v_branch bigint;
  v_start  timestamptz;
  v_reader public.readers%rowtype;
begin
  if not public.is_staff() then
    return public.result(false, 'admin_only', 'Only admins and receptionists can record check-ins.');
  end if;
  select * into v_b from public.bookings where booking_id = p_booking_id for update;
  if not found then
    return public.result(false, 'booking_not_found', 'Booking not found.');
  end if;
  if v_b.booking_status = 'Attended' then
    return public.result(false, 'already_checked_in', 'Already checked in.');
  end if;
  if v_b.booking_status <> 'Confirmed' then
    return public.result(false, 'not_checkinable', 'This booking cannot be checked in.');
  end if;
  select * into v_reader from public.readers where reader_id = p_reader_id;
  if not found then
    return public.result(false, 'unknown_reader', 'Unknown reader.');
  end if;
  select branch_id, start_time into v_branch, v_start from public.class_sessions where session_id = v_b.session_id;
  if v_reader.branch_id <> v_branch then
    return public.result(false, 'wrong_branch_reader', 'This reader belongs to a different branch.');
  end if;
  -- check-in opens 30 minutes before the class starts
  if now() < v_start - interval '30 minutes' then
    return public.result(false, 'checkin_too_early', 'Check-in opens 30 minutes before the class starts.');
  end if;

  insert into public.check_in_logs (booking_id, reader_id) values (p_booking_id, p_reader_id);
  update public.bookings set booking_status = 'Attended' where booking_id = p_booking_id;
  return public.result(true, 'checked_in', 'Check-in recorded.');
end $$;

-- Optional: bookings that were checked in too early by the old rule are still
-- 'Attended'. To put future ones back to 'Confirmed', uncomment and run:
-- delete from public.check_in_logs l
--  using public.bookings b, public.class_sessions s
--  where l.booking_id = b.booking_id and s.session_id = b.session_id
--    and s.start_time - interval '30 minutes' > now();
-- update public.bookings b set booking_status = 'Confirmed'
--   from public.class_sessions s
--  where s.session_id = b.session_id and b.booking_status = 'Attended'
--    and s.start_time - interval '30 minutes' > now();

commit;
