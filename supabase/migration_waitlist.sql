-- =====================================================================
-- WAITLIST. Run ONCE in the Supabase SQL Editor, after the other
-- migrations. Purely additive: no existing table, view or function is changed.
--
-- A member can join the queue of a FULL class. When a place frees up (someone
-- cancels, or the admin raises the capacity), the first person in the queue is
-- booked automatically and sees it in My Profile.
--
-- The queue closes 3 hours before the start: after that a cancellation would
-- cost the fee, so nobody is booked without having chosen it. From then on a
-- free place is simply bookable by anyone.
--
-- Promotion runs in a DEFERRED trigger, i.e. at the end of the transaction.
-- That matters for cancel_session(): it cancels the bookings first and marks
-- the class cancelled afterwards; a normal trigger would book the queue into
-- the class that is being cancelled.
-- =====================================================================

begin;

-- ---------- 1. Table ----------
create table if not exists public.waitlist (
  entry_id       bigint generated always as identity primary key,
  session_id     bigint not null references public.class_sessions(session_id),
  member_id      bigint not null references public.members(member_id) on delete cascade,
  status         varchar(10) not null default 'Waiting'
                 check (status in ('Waiting', 'Promoted', 'Left', 'Expired')),
  -- Promoted: auto = booked by the queue, otherwise the member booked it themself
  promoted_auto  boolean not null default false,
  -- Expired: why the member was skipped (membership, time_conflict, session_cancelled)
  status_reason  varchar(20),
  booking_id     bigint references public.bookings(booking_id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
-- a member waits at most once per class
create unique index if not exists waitlist_one_waiting on public.waitlist (session_id, member_id)
  where status = 'Waiting';
create index if not exists waitlist_queue on public.waitlist (session_id, created_at) where status = 'Waiting';

alter table public.waitlist enable row level security;
revoke all on public.waitlist from anon, authenticated;

-- ---------- 2. Promote: fill free places from the queue ----------
-- Internal: called by the triggers below, not by the app.
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

-- ---------- 3. Triggers ----------
-- a place freed up (booking cancelled) -> promote at the end of the transaction
create or replace function public.waitlist_on_booking_cancel() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    perform public.promote_waitlist(new.session_id);
  exception when others then
    -- never let the queue break the cancellation itself
    raise warning 'waitlist promotion failed for session %: %', new.session_id, sqlerrm;
  end;
  return null;
end $$;

drop trigger if exists trg_waitlist_on_booking_cancel on public.bookings;
create constraint trigger trg_waitlist_on_booking_cancel
after update of booking_status on public.bookings
deferrable initially deferred
for each row
when (new.booking_status = 'Cancelled' and old.booking_status <> 'Cancelled')
execute function public.waitlist_on_booking_cancel();

-- more places (capacity raised) or the class was cancelled
create or replace function public.waitlist_on_session_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    perform public.promote_waitlist(new.session_id);
  exception when others then
    raise warning 'waitlist promotion failed for session %: %', new.session_id, sqlerrm;
  end;
  return null;
end $$;

drop trigger if exists trg_waitlist_on_session_change on public.class_sessions;
create constraint trigger trg_waitlist_on_session_change
after update of capacity, cancelled_at on public.class_sessions
deferrable initially deferred
for each row
when (new.capacity > old.capacity or (new.cancelled_at is not null and old.cancelled_at is null))
execute function public.waitlist_on_session_change();

-- the member booked the class themself (a place was free) -> no longer waiting
create or replace function public.waitlist_on_booking_confirmed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.waitlist set status = 'Promoted', booking_id = new.booking_id, updated_at = now()
   where session_id = new.session_id and member_id = new.member_id and status = 'Waiting';
  return null;
end $$;

drop trigger if exists trg_waitlist_on_booking_confirmed on public.bookings;
create trigger trg_waitlist_on_booking_confirmed
after insert or update of booking_status on public.bookings
for each row when (new.booking_status = 'Confirmed')
execute function public.waitlist_on_booking_confirmed();

-- ---------- 4. Views ----------
-- queue length per upcoming class (public, for the schedule)
create or replace view public.v_waitlist_counts as
select w.session_id, count(*)::int as waiting
from public.waitlist w
join public.class_sessions s on s.session_id = w.session_id
where w.status = 'Waiting' and s.cancelled_at is null and s.start_time - now() >= interval '3 hours'
group by w.session_id;

-- the member's own queue entries with the place in the queue
create or replace view public.v_my_waitlist as
select w.entry_id, w.session_id, w.booking_id, w.promoted_auto, w.status_reason, w.created_at, w.updated_at,
       case when w.status = 'Waiting' and (s.cancelled_at is not null or s.start_time - now() < interval '3 hours')
            then 'Expired' else w.status end as status,
       case when w.status = 'Waiting' then
         (select count(*) from public.waitlist q
           where q.session_id = w.session_id and q.status = 'Waiting'
             and (q.created_at, q.entry_id) <= (w.created_at, w.entry_id))::int end as position,
       c.class_name, t.trainer_name, br.branch_name, r.room_name, s.start_time, s.end_time
from public.waitlist w
join public.members m on m.member_id = w.member_id
join public.class_sessions s on s.session_id = w.session_id
join public.classes  c  on c.class_id   = s.class_id
join public.trainers t  on t.trainer_id = s.trainer_id
join public.branches br on br.branch_id = s.branch_id
join public.rooms    r  on r.room_id    = s.room_id
where m.auth_user_id = auth.uid();

grant select on public.v_waitlist_counts to anon, authenticated;
revoke all on public.v_my_waitlist from anon;
grant select on public.v_my_waitlist to authenticated;

-- ---------- 5. Join / leave ----------
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

create or replace function public.leave_waitlist(p_session_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  update public.waitlist w set status = 'Left', updated_at = now()
    from public.members m
   where m.member_id = w.member_id and m.auth_user_id = auth.uid()
     and w.session_id = p_session_id and w.status = 'Waiting';
  if not found then
    return public.result(false, 'not_waiting', 'You are not in the queue for this class.');
  end if;
  return public.result(true, 'waitlist_left', 'You left the queue.');
end $$;

revoke all on function public.join_waitlist(bigint)  from public, anon;
revoke all on function public.leave_waitlist(bigint) from public, anon;
grant execute on function public.join_waitlist(bigint)  to authenticated;
grant execute on function public.leave_waitlist(bigint) to authenticated;

commit;
