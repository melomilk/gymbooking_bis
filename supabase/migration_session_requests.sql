-- =====================================================================
-- TRAINER CLASS REQUESTS. Run ONCE in the Supabase SQL Editor, after the
-- other migrations. Purely additive: no existing table, view or function is
-- changed.
--
-- A trainer proposes a class: type, room, date and time, capacity, a note.
-- The end time follows from the class duration. The admin approves it (the
-- class appears in the schedule at once) or rejects it with a reason, e.g.
-- "Studio A is busy, try 19:00". The schedule itself stays the admin's:
-- a trainer can't create classes directly.
--
-- Checks when the trainer sends it: time in the future (at most 60 days
-- ahead), capacity 1..room size, the room and the trainer are free at that
-- time, and no other open request of the same trainer overlaps.
-- On approval the same rules are enforced again by the class_sessions
-- constraints (someone may have taken the room in the meantime).
-- =====================================================================

begin;

-- ---------- 1. Table ----------
create table if not exists public.session_requests (
  request_id     bigint generated always as identity primary key,
  trainer_id     bigint not null references public.trainers(trainer_id) on delete cascade,
  requested_by   bigint references public.members(member_id) on delete set null,
  class_id       bigint not null references public.classes(class_id),
  branch_id      bigint not null references public.branches(branch_id),
  room_id        bigint not null,
  start_time     timestamptz not null,
  end_time       timestamptz not null,
  capacity       int not null check (capacity > 0),
  note           varchar(300),
  status         varchar(10) not null default 'Pending'
                 check (status in ('Pending', 'Approved', 'Rejected', 'Withdrawn')),
  reject_reason  varchar(300),
  created_at     timestamptz not null default now(),
  reviewed_at    timestamptz,
  reviewed_by    bigint references public.members(member_id) on delete set null,
  session_id     bigint references public.class_sessions(session_id) on delete set null,
  check (end_time > start_time),
  foreign key (room_id, branch_id) references public.rooms(room_id, branch_id)
);
create index if not exists session_requests_trainer on public.session_requests (trainer_id, created_at);
create index if not exists session_requests_pending on public.session_requests (created_at) where status = 'Pending';

alter table public.session_requests enable row level security;
revoke all on public.session_requests from anon, authenticated;

-- ---------- 2. What a trainer may choose from ----------
-- classes and rooms are admin-only tables; these read-only views give
-- logged-in users the names, durations and room sizes the form needs.
create or replace view public.v_class_types as
select class_id, class_name, duration_min from public.classes;

create or replace view public.v_rooms as
select r.room_id, r.room_name, r.max_capacity, r.branch_id, b.branch_name
from public.rooms r join public.branches b on b.branch_id = r.branch_id;

-- requests: the trainer sees own ones, the admin sees all
create or replace view public.v_session_requests as
select q.request_id, q.trainer_id, t.trainer_name, q.class_id, c.class_name, c.duration_min,
       q.branch_id, b.branch_name, q.room_id, r.room_name, r.max_capacity,
       q.start_time, q.end_time, q.capacity, q.note, q.status, q.reject_reason,
       q.created_at, q.reviewed_at, q.session_id
from public.session_requests q
join public.trainers t on t.trainer_id = q.trainer_id
join public.classes  c on c.class_id   = q.class_id
join public.branches b on b.branch_id  = q.branch_id
join public.rooms    r on r.room_id    = q.room_id
where public.is_admin()
   or q.trainer_id = (select me.trainer_id from public.members me
                       where me.auth_user_id = auth.uid() and me.role = 'Trainer');

revoke all on public.v_class_types, public.v_rooms, public.v_session_requests from anon;
grant select on public.v_class_types, public.v_rooms, public.v_session_requests to authenticated;

-- ---------- 3. Shared check: is the slot free? ----------
-- Returns null if free, otherwise room_overlap / trainer_overlap / request_overlap.
create or replace function public.session_slot_problem(
  p_trainer_id bigint, p_room_id bigint, p_start timestamptz, p_end timestamptz, p_skip_request bigint
) returns text
language sql stable security definer set search_path = public as $$
  select case
    when exists (select 1 from public.class_sessions s
                  where s.room_id = p_room_id and s.cancelled_at is null
                    and tstzrange(s.start_time, s.end_time) && tstzrange(p_start, p_end)) then 'room_overlap'
    when exists (select 1 from public.class_sessions s
                  where s.trainer_id = p_trainer_id and s.cancelled_at is null
                    and tstzrange(s.start_time, s.end_time) && tstzrange(p_start, p_end)) then 'trainer_overlap'
    when exists (select 1 from public.session_requests q
                  where q.trainer_id = p_trainer_id and q.status = 'Pending'
                    and q.request_id is distinct from p_skip_request
                    and tstzrange(q.start_time, q.end_time) && tstzrange(p_start, p_end)) then 'request_overlap'
  end
$$;
revoke all on function public.session_slot_problem(bigint, bigint, timestamptz, timestamptz, bigint) from public, anon, authenticated;

-- ---------- 4. Trainer: send / withdraw ----------
create or replace function public.submit_session_request(
  p_class_id bigint, p_room_id bigint, p_start_time timestamptz, p_capacity int, p_note text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me      public.members%rowtype;
  v_class   public.classes%rowtype;
  v_room    public.rooms%rowtype;
  v_end     timestamptz;
  v_problem text;
  v_note    text := nullif(trim(coalesce(p_note, '')), '');
begin
  -- the member row is locked, so two parallel requests can't both pass the overlap check
  select * into v_me from public.members where auth_user_id = auth.uid() for update;
  if not found then
    return public.result(false, 'not_signed_in', 'Please log in first.');
  end if;
  if v_me.role <> 'Trainer' or v_me.trainer_id is null then
    return public.result(false, 'trainer_only', 'Only trainers can propose classes.');
  end if;
  select * into v_class from public.classes where class_id = p_class_id;
  select * into v_room from public.rooms where room_id = p_room_id;
  if v_class.class_id is null or v_room.room_id is null or p_start_time is null then
    return public.result(false, 'required', 'Fill in all required fields.');
  end if;
  if p_start_time <= now() + interval '1 hour' then
    return public.result(false, 'request_too_soon', 'Propose a class at least 1 hour ahead.');
  end if;
  if p_start_time > now() + interval '60 days' then
    return public.result(false, 'request_too_far', 'Propose a class at most 60 days ahead.');
  end if;
  if p_capacity is null or p_capacity < 1 then
    return public.result(false, 'invalid_value', 'Invalid value.');
  end if;
  if p_capacity > v_room.max_capacity then
    return public.result(false, 'capacity_exceeds_room', 'The room is too small for this capacity.');
  end if;
  if length(coalesce(v_note, '')) > 300 then
    return public.result(false, 'invalid_value', 'The note is too long.');
  end if;
  if (select count(*) from public.session_requests
       where trainer_id = v_me.trainer_id and status = 'Pending') >= 10 then
    return public.result(false, 'request_limit', 'You can have at most 10 requests waiting.');
  end if;

  v_end := p_start_time + make_interval(mins => v_class.duration_min);
  v_problem := public.session_slot_problem(v_me.trainer_id, v_room.room_id, p_start_time, v_end, null);
  if v_problem is not null then
    return public.result(false, v_problem, 'This time is not free.');
  end if;

  insert into public.session_requests (trainer_id, requested_by, class_id, branch_id, room_id,
                                       start_time, end_time, capacity, note)
  values (v_me.trainer_id, v_me.member_id, v_class.class_id, v_room.branch_id, v_room.room_id,
          p_start_time, v_end, p_capacity, v_note);
  return public.result(true, 'request_sent', 'Request sent. The admin will review it.');
end $$;

create or replace function public.withdraw_session_request(p_request_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  update public.session_requests q set status = 'Withdrawn'
    from public.members m
   where q.request_id = p_request_id and q.status = 'Pending'
     and m.auth_user_id = auth.uid() and m.role = 'Trainer' and m.trainer_id = q.trainer_id;
  if not found then
    return public.result(false, 'request_not_pending', 'This request can no longer be changed.');
  end if;
  return public.result(true, 'request_withdrawn', 'Request withdrawn.');
end $$;

-- ---------- 5. Admin: approve (creates the class) / reject ----------
create or replace function public.review_session_request(p_request_id bigint, p_approve boolean, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_q          public.session_requests%rowtype;
  v_admin      bigint;
  v_session    bigint;
  v_problem    text;
  v_constraint text;
begin
  if not public.is_admin() then
    return public.result(false, 'admin_only', 'Only admins can do this.');
  end if;
  select member_id into v_admin from public.members where auth_user_id = auth.uid();
  select * into v_q from public.session_requests where request_id = p_request_id for update;
  if not found then
    return public.result(false, 'request_not_found', 'Request not found.');
  end if;
  if v_q.status <> 'Pending' then
    return public.result(false, 'request_not_pending', 'This request has already been reviewed.');
  end if;

  if not p_approve then
    update public.session_requests
       set status = 'Rejected', reject_reason = left(nullif(trim(coalesce(p_reason, '')), ''), 300),
           reviewed_at = now(), reviewed_by = v_admin
     where request_id = p_request_id;
    return public.result(true, 'request_rejected', 'Request rejected.');
  end if;

  if v_q.start_time <= now() then
    return public.result(false, 'request_expired', 'The proposed time has already passed.');
  end if;
  -- someone may have taken the room or the trainer since the request was sent
  v_problem := public.session_slot_problem(v_q.trainer_id, v_q.room_id, v_q.start_time, v_q.end_time, v_q.request_id);
  if v_problem in ('room_overlap', 'trainer_overlap') then
    return public.result(false, v_problem, 'This time is no longer free.');
  end if;

  begin
    insert into public.class_sessions (class_id, trainer_id, branch_id, room_id, start_time, end_time, capacity)
    values (v_q.class_id, v_q.trainer_id, v_q.branch_id, v_q.room_id, v_q.start_time, v_q.end_time, v_q.capacity)
    returning session_id into v_session;
  exception
    when exclusion_violation then   -- the constraints on class_sessions, in case of a race
      get stacked diagnostics v_constraint = constraint_name;
      return public.result(false, case when v_constraint like '%trainer%' then 'trainer_overlap' else 'room_overlap' end,
                           'This time is no longer free.');
    when raise_exception then        -- check_session_capacity(): the room got smaller
      return public.result(false, 'capacity_exceeds_room', 'The room is too small for this capacity.');
  end;

  update public.session_requests
     set status = 'Approved', reviewed_at = now(), reviewed_by = v_admin, session_id = v_session
   where request_id = p_request_id;
  return public.result(true, 'request_approved', 'Approved. The class is in the schedule.');
end $$;

revoke all on function public.submit_session_request(bigint, bigint, timestamptz, int, text) from public, anon;
revoke all on function public.withdraw_session_request(bigint)                            from public, anon;
revoke all on function public.review_session_request(bigint, boolean, text)               from public, anon;
grant execute on function public.submit_session_request(bigint, bigint, timestamptz, int, text) to authenticated;
grant execute on function public.withdraw_session_request(bigint)                            to authenticated;
grant execute on function public.review_session_request(bigint, boolean, text)               to authenticated;

commit;
