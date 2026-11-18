-- =====================================================================
-- Cancelling a class, and protecting booked classes (manual test table, cases 6-7).
-- Run ONCE in the Supabase SQL editor on the deployed database, AFTER
-- migration_booking_rules.sql. New databases made from schema.sql already have this.
--
--   1. class_sessions.cancelled_at: an admin can cancel a class (cancel_session).
--      Its confirmed bookings are cancelled free of charge, it disappears from the
--      schedule, and members see "Cancelled by the gym" (test case 6).
--      A cancelled class no longer blocks its room / trainer for a new class.
--   2. A class that has bookings can't get a new date, time, room or class type
--      (trigger protect_booked_session). Trainer and capacity can still change
--      (test case 7).
-- =====================================================================

begin;

-- 1. cancelled flag ----------------------------------------------------
alter table public.class_sessions add column if not exists cancelled_at timestamptz;

alter table public.class_sessions drop constraint if exists no_room_overlap;
alter table public.class_sessions drop constraint if exists no_trainer_overlap;
alter table public.class_sessions add constraint no_room_overlap
  exclude using gist (room_id with =, tstzrange(start_time, end_time) with &&) where (cancelled_at is null);
alter table public.class_sessions add constraint no_trainer_overlap
  exclude using gist (trainer_id with =, tstzrange(start_time, end_time) with &&) where (cancelled_at is null);

-- views: new columns are added at the end, cancelled classes are left out of
-- the trainer roster and the attendance report
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

create or replace view public.v_bookings as
select b.booking_id, b.member_id, b.session_id, b.booking_status, b.booking_time,
       b.cancelled_at, b.fee_forfeited,
       m.member_name || ' ' || m.member_surname as member_fullname,
       c.class_name, s.trainer_id, t.trainer_name, s.branch_id, br.branch_name, r.room_name,
       s.start_time, s.end_time, s.cancelled_at as session_cancelled_at
from public.bookings b
join public.members  m  on m.member_id  = b.member_id
join public.class_sessions s on s.session_id = b.session_id
join public.classes  c  on c.class_id   = s.class_id
join public.trainers t  on t.trainer_id = s.trainer_id
join public.branches br on br.branch_id = s.branch_id
join public.rooms    r  on r.room_id    = s.room_id
where m.auth_user_id = auth.uid() or public.is_staff();

create or replace view public.v_trainer_roster as
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
                       where me.auth_user_id = auth.uid() and me.role = 'Trainer')
  and s.cancelled_at is null;

create or replace view public.v_attendance_report as
select s.session_id, c.class_name, t.trainer_name, br.branch_name, s.start_time, s.end_time, s.capacity,
       count(b.booking_id) filter (where b.booking_status <> 'Cancelled')::int as booked,
       count(b.booking_id) filter (where b.booking_status = 'Attended')::int  as attended,
       count(b.booking_id) filter (where b.booking_status = 'No-show')::int   as no_show
from public.class_sessions s
join public.classes  c  on c.class_id   = s.class_id
join public.trainers t  on t.trainer_id = s.trainer_id
join public.branches br on br.branch_id = s.branch_id
left join public.bookings b on b.session_id = s.session_id
where public.is_admin() and s.cancelled_at is null
group by s.session_id, c.class_name, t.trainer_name, br.branch_name;

-- booking a cancelled class is refused
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

-- 2. booked classes keep their date, time, room and class type -----------
create or replace function public.protect_booked_session() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.cancelled_at is not null then
    raise exception 'session_is_cancelled';
  end if;
  if (new.class_id, new.room_id, new.branch_id, new.start_time, new.end_time)
       is distinct from (old.class_id, old.room_id, old.branch_id, old.start_time, old.end_time)
     and exists (select 1 from public.bookings
                  where session_id = old.session_id and booking_status <> 'Cancelled') then
    raise exception 'session_has_bookings';
  end if;
  return new;
end $$;

drop trigger if exists trg_protect_booked_session on public.class_sessions;
create trigger trg_protect_booked_session
before update on public.class_sessions
for each row execute function public.protect_booked_session();

-- cancel a whole class (admin) --------------------------------------------
create or replace function public.cancel_session(p_session_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_s public.class_sessions%rowtype;
  v_n int;
begin
  if not public.is_admin() then
    return public.result(false, 'forbidden', 'Only admins can cancel classes.');
  end if;
  select * into v_s from public.class_sessions where session_id = p_session_id for update;
  if not found then
    return public.result(false, 'session_not_found', 'Class session not found.');
  end if;
  if v_s.cancelled_at is not null then
    return public.result(false, 'session_is_cancelled', 'This class is already cancelled.');
  end if;
  if v_s.start_time <= now() then
    return public.result(false, 'class_started', 'This class has already started.');
  end if;

  update public.bookings
     set booking_status = 'Cancelled', cancelled_at = now(), fee_forfeited = false
   where session_id = p_session_id and booking_status = 'Confirmed';
  get diagnostics v_n = row_count;
  update public.class_sessions set cancelled_at = now() where session_id = p_session_id;
  return public.result(true, 'session_cancelled_done',
    format('Class cancelled. %s booking(s) cancelled free of charge.', v_n));
end $$;

revoke all on function public.cancel_session(bigint) from public, anon;
grant execute on function public.cancel_session(bigint) to authenticated;

commit;
