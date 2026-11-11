-- Run ONCE in the Supabase SQL editor on a database created from an older
-- schema.sql. Adds:
--   1. No-show rule: a booking still 'Confirmed' after its class has ended
--      becomes 'No-show' and its booking fee is forfeited.
--   2. Attendance report view for the admin panel.
--   3. Manual check-in (Plan B when the NFC reader fails).

-- ---------- 1. No-show ----------

create or replace function public.mark_no_shows() returns int
language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  update public.bookings b
     set booking_status = 'No-show', fee_forfeited = true
    from public.class_sessions s
   where s.session_id = b.session_id
     and b.booking_status = 'Confirmed'
     and s.end_time < now();
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function public.mark_no_shows() from public, anon;
grant execute on function public.mark_no_shows() to authenticated;

-- Fix the bookings that are already stuck as 'Confirmed' for past classes.
select public.mark_no_shows();

-- ---------- 2. Attendance report ----------
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
where public.is_admin()
group by s.session_id, c.class_name, t.trainer_name, br.branch_name;

grant select on public.v_attendance_report to authenticated;

-- ---------- 3. Manual check-in ----------
alter table public.check_in_logs alter column reader_id drop not null;
alter table public.check_in_logs add column if not exists is_manual boolean not null default false;
alter table public.check_in_logs add constraint check_in_logs_reader_or_manual
  check (is_manual or reader_id is not null);

create or replace function public.manual_check_in(p_booking_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_b     public.bookings%rowtype;
  v_start timestamptz;
begin
  if not public.is_admin() then
    return public.result(false, 'admin_only', 'Only admins can record check-ins.');
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

revoke all on function public.manual_check_in(bigint) from public, anon;
grant execute on function public.manual_check_in(bigint) to authenticated;

-- Optional: if the pg_cron extension is enabled, also run it every 15 minutes
-- so statuses update even when nobody opens the site.
-- select cron.schedule('mark-no-shows', '*/15 * * * *', 'select public.mark_no_shows()');
