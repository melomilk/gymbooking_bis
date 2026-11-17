-- =====================================================================
-- Receptionist role. Run ONCE in the Supabase SQL editor on a database
-- created from an older schema.sql (new databases already have this).
--
--   1. members.role: 'Receptionist' is 12 characters but the column was
--      varchar(10), so it is widened; the CHECK list gets the new role.
--   2. is_staff() = Admin or Receptionist.
--   3. v_bookings, v_readers, check_in_booking(), manual_check_in() accept
--      is_staff() instead of is_admin(). Everything else stays admin only.
-- =====================================================================

begin;

-- 1. role column ------------------------------------------------------
-- Postgres refuses to change a column type while views use it, so the two
-- views that read members.role are dropped and created again below.
drop view if exists public.v_me;
drop view if exists public.v_trainer_roster;

alter table public.members alter column role type varchar(20);

do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.members'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%Member%' and pg_get_constraintdef(oid) like '%Admin%'
  loop
    execute format('alter table public.members drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.members
  add constraint members_role_check check (role in ('Member', 'Trainer', 'Receptionist', 'Admin'));

create view public.v_me as
select m.member_id, m.member_name, m.member_surname, m.membership_status,
       m.membership_expiry, m.phone_number, m.role, m.trainer_id, m.preferred_language,
       case when m.membership_status = 'Suspended' then 'Suspended'
            when m.membership_expiry < current_date then 'Expired'
            else 'Active' end as effective_status
from public.members m
where m.auth_user_id = auth.uid();

create view public.v_trainer_roster as
select s.session_id, c.class_name, br.branch_name, r.room_name, s.start_time, s.end_time,
       s.capacity, b.booking_id, b.booking_status,
       m.member_name || ' ' || m.member_surname as member_fullname
from public.class_sessions s
join public.classes  c  on c.class_id  = s.class_id
join public.branches br on br.branch_id = s.branch_id
join public.rooms    r  on r.room_id   = s.room_id
left join public.bookings b on b.session_id = s.session_id and b.booking_status <> 'Cancelled'
left join public.members  m on m.member_id  = b.member_id
where s.trainer_id = (select me.trainer_id from public.members me
                       where me.auth_user_id = auth.uid() and me.role = 'Trainer');

grant select on public.v_me, public.v_trainer_roster to authenticated;

-- 2. helper -----------------------------------------------------------
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select public.my_role() in ('Admin', 'Receptionist')
$$;

-- 3. front-desk access ------------------------------------------------
create or replace view public.v_bookings as
select b.booking_id, b.member_id, b.session_id, b.booking_status, b.booking_time,
       b.cancelled_at, b.fee_forfeited,
       m.member_name || ' ' || m.member_surname as member_fullname,
       c.class_name, s.trainer_id, t.trainer_name, s.branch_id, br.branch_name, r.room_name,
       s.start_time, s.end_time
from public.bookings b
join public.members  m  on m.member_id  = b.member_id
join public.class_sessions s on s.session_id = b.session_id
join public.classes  c  on c.class_id   = s.class_id
join public.trainers t  on t.trainer_id = s.trainer_id
join public.branches br on br.branch_id = s.branch_id
join public.rooms    r  on r.room_id    = s.room_id
where m.auth_user_id = auth.uid() or public.is_staff();

create or replace view public.v_readers as
select r.reader_id, r.branch_id, br.branch_name, r.check_in_method, r.location_note
from public.readers r
join public.branches br on br.branch_id = r.branch_id
where public.is_staff();

create or replace function public.check_in_booking(p_booking_id bigint, p_reader_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_b      public.bookings%rowtype;
  v_branch bigint;
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
  select branch_id into v_branch from public.class_sessions where session_id = v_b.session_id;
  if v_reader.branch_id <> v_branch then
    return public.result(false, 'wrong_branch_reader', 'This reader belongs to a different branch.');
  end if;

  insert into public.check_in_logs (booking_id, reader_id) values (p_booking_id, p_reader_id);
  update public.bookings set booking_status = 'Attended' where booking_id = p_booking_id;
  return public.result(true, 'checked_in', 'Check-in recorded.');
end $$;

create or replace function public.manual_check_in(p_booking_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_b     public.bookings%rowtype;
  v_start timestamptz;
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
  if v_b.booking_status not in ('Confirmed', 'No-show') then
    return public.result(false, 'not_checkinable', 'This booking cannot be checked in.');
  end if;
  select start_time into v_start from public.class_sessions where session_id = v_b.session_id;
  if v_start > now() then
    return public.result(false, 'class_not_started', 'The class has not started yet.');
  end if;

  insert into public.check_in_logs (booking_id, reader_id, is_manual) values (p_booking_id, null, true);
  update public.bookings set booking_status = 'Attended', fee_forfeited = false where booking_id = p_booking_id;
  return public.result(true, 'checked_in_manual', 'Marked as attended manually.');
end $$;

commit;
