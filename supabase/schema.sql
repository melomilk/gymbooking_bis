-- =====================================================================
-- GYM BOOKING SYSTEM - Supabase (PostgreSQL) schema
-- Run this whole file once in: Supabase Dashboard -> SQL Editor -> New query
-- Then run supabase/seed.sql for demo data.
--
-- Functions return {ok, code, message}. The web app translates `code`
-- into Kazakh / English / Russian (FR-07); `message` is the English text.
-- =====================================================================

create extension if not exists btree_gist;   -- for "no overlapping sessions" rules

-- ---------------------------------------------------------------------
-- TABLES
-- ---------------------------------------------------------------------

create table public.branches (
  branch_id     bigint generated always as identity primary key,
  branch_name   varchar(100) not null,
  address       varchar(255) not null,
  phone_number  varchar(20)  not null unique
);

-- unique(room_id, branch_id) lets class_sessions use a composite FK so a
-- session can never point to a room in a different branch.
create table public.rooms (
  room_id       bigint generated always as identity primary key,
  branch_id     bigint not null references public.branches(branch_id),
  room_name     varchar(50) not null,
  max_capacity  int not null check (max_capacity > 0),
  unique (branch_id, room_name),
  unique (room_id, branch_id)
);

create table public.trainers (
  trainer_id    bigint generated always as identity primary key,
  trainer_name  varchar(100) not null,
  phone         varchar(20),
  email         varchar(150)
);

create table public.classes (
  class_id      bigint generated always as identity primary key,
  class_name    varchar(50) not null unique,
  description   text,
  duration_min  int not null check (duration_min > 0)
);

create table public.members (
  member_id          bigint generated always as identity primary key,
  auth_user_id       uuid unique references auth.users(id) on delete set null,
  member_name        varchar(100) not null check (length(trim(member_name)) > 0),
  member_surname     varchar(100) not null check (length(trim(member_surname)) > 0),
  -- 'Expired' is NOT stored: it is derived from membership_expiry.
  -- This column is only a manual flag set by an admin.
  membership_status  varchar(10) not null default 'Active'
                     check (membership_status in ('Active', 'Suspended')),
  membership_expiry  date not null,
  phone_number       varchar(20) not null unique,             -- FR-04: login is by phone
  role               varchar(10) not null default 'Member'
                     check (role in ('Member', 'Trainer', 'Admin')),   -- FR-10
  trainer_id         bigint unique references public.trainers(trainer_id),
  preferred_language varchar(2) not null default 'en'
                     check (preferred_language in ('kk', 'en', 'ru')), -- FR-07
  check (role <> 'Trainer' or trainer_id is not null)
);

create table public.class_sessions (
  session_id   bigint generated always as identity primary key,
  class_id     bigint not null references public.classes(class_id),
  trainer_id   bigint not null references public.trainers(trainer_id),
  branch_id    bigint not null references public.branches(branch_id),
  room_id      bigint not null,
  start_time   timestamptz not null,
  end_time     timestamptz not null,
  capacity     int not null check (capacity > 0),
  check (end_time > start_time),
  foreign key (room_id, branch_id) references public.rooms(room_id, branch_id),
  constraint no_room_overlap
    exclude using gist (room_id with =, tstzrange(start_time, end_time) with &&),
  constraint no_trainer_overlap
    exclude using gist (trainer_id with =, tstzrange(start_time, end_time) with &&)
);
create index on public.class_sessions (start_time);

create table public.bookings (
  booking_id      bigint generated always as identity primary key,
  member_id       bigint not null references public.members(member_id),
  session_id      bigint not null references public.class_sessions(session_id),
  booking_status  varchar(10) not null default 'Confirmed'
                  check (booking_status in ('Confirmed', 'Cancelled', 'Attended', 'No-show')),
  booking_time    timestamptz not null default now(),
  cancelled_at    timestamptz,
  fee_forfeited   boolean not null default false,   -- FR-06: late cancellation
  unique (member_id, session_id)                    -- FR-02
);
create index on public.bookings (session_id);

-- READERS: fixes check_in_id -> reader_id -> check_in_method; linked to a branch.
create table public.readers (
  reader_id         varchar(20) primary key,
  branch_id         bigint not null references public.branches(branch_id),
  check_in_method   varchar(10) not null default 'NFC',
  location_note     varchar(100)
);

create table public.check_in_logs (
  check_in_id    bigint generated always as identity primary key,
  booking_id     bigint not null unique references public.bookings(booking_id),
  check_in_time  timestamptz not null default now(),
  reader_id      varchar(20) references public.readers(reader_id),
  is_manual      boolean not null default false,       -- Plan B: NFC failed, admin marked it
  check (is_manual or reader_id is not null)           -- an NFC check-in always has a reader
);

-- Session capacity: never above the room's size, never below the number of
-- places already taken (NFR-01 when an admin edits a session).
create function public.check_session_capacity() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_max int; v_taken int;
begin
  select max_capacity into v_max from public.rooms where room_id = new.room_id;
  if new.capacity > v_max then
    raise exception 'capacity_exceeds_room';
  end if;
  if tg_op = 'UPDATE' then
    select count(*) into v_taken from public.bookings
     where session_id = new.session_id and booking_status <> 'Cancelled';
    if new.capacity < v_taken then
      raise exception 'capacity_below_bookings';
    end if;
  end if;
  return new;
end $$;

create trigger trg_session_capacity
before insert or update on public.class_sessions
for each row execute function public.check_session_capacity();

-- ---------------------------------------------------------------------
-- ROLE HELPERS (FR-10)
-- ---------------------------------------------------------------------
create function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select m.role from public.members m where m.auth_user_id = auth.uid()), 'Anonymous')
$$;

create function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select public.my_role() = 'Admin'
$$;

-- ---------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- Members/visitors: read the schedule through views, write only through
-- functions. Admins: full CRUD on catalog tables (FR-09).
-- ---------------------------------------------------------------------
alter table public.branches        enable row level security;
alter table public.rooms           enable row level security;
alter table public.trainers        enable row level security;
alter table public.classes         enable row level security;
alter table public.members         enable row level security;
alter table public.class_sessions  enable row level security;
alter table public.bookings        enable row level security;
alter table public.readers         enable row level security;
alter table public.check_in_logs   enable row level security;

create policy "branches readable by all" on public.branches for select using (true);
create policy "admin manages branches"   on public.branches for all
  using (public.is_admin()) with check (public.is_admin());
create policy "admin manages rooms"      on public.rooms for all
  using (public.is_admin()) with check (public.is_admin());
create policy "admin manages trainers"   on public.trainers for all
  using (public.is_admin()) with check (public.is_admin());
create policy "admin manages classes"    on public.classes for all
  using (public.is_admin()) with check (public.is_admin());
create policy "admin manages sessions"   on public.class_sessions for all
  using (public.is_admin()) with check (public.is_admin());
create policy "admin reads members"      on public.members for select using (public.is_admin());
create policy "admin updates members"    on public.members for update
  using (public.is_admin()) with check (public.is_admin());
create policy "admin reads readers"      on public.readers for select using (public.is_admin());

-- ---------------------------------------------------------------------
-- VIEWS (owner rights; each one filters by auth.uid() / role itself)
-- ---------------------------------------------------------------------

-- Public schedule: no trainer contacts, no member data, only a seat count.
create view public.v_sessions as
select s.session_id, s.class_id, c.class_name, c.description, c.duration_min,
       s.trainer_id, t.trainer_name, s.branch_id, br.branch_name, s.room_id, r.room_name,
       s.start_time, s.end_time, s.capacity,
       (select count(*) from public.bookings b
         where b.session_id = s.session_id and b.booking_status <> 'Cancelled')::int as spots_taken
from public.class_sessions s
join public.classes  c  on c.class_id   = s.class_id
join public.trainers t  on t.trainer_id = s.trainer_id
join public.branches br on br.branch_id = s.branch_id
join public.rooms    r  on r.room_id    = s.room_id;

-- Public trainer names (for search, FR-08). Contacts stay admin-only.
create view public.v_trainers as
select trainer_id, trainer_name from public.trainers;

create view public.v_me as
select m.member_id, m.member_name, m.member_surname, m.membership_status,
       m.membership_expiry, m.phone_number, m.role, m.trainer_id, m.preferred_language,
       case when m.membership_status = 'Suspended' then 'Suspended'
            when m.membership_expiry < current_date then 'Expired'
            else 'Active' end as effective_status
from public.members m
where m.auth_user_id = auth.uid();

-- Bookings with session details. Members see their own rows, admins see all
-- rows (FR-08), everyone else sees nothing.
create view public.v_bookings as
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
where m.auth_user_id = auth.uid() or public.is_admin();

-- Trainer roster: a trainer sees only attendee NAMES for their own classes.
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

-- Attendance report (admin only): per session, how many booked, came and
-- missed. The attendance rate is attended / (attended + no_show).
create view public.v_attendance_report as
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

create view public.v_readers as
select r.reader_id, r.branch_id, br.branch_name, r.check_in_method, r.location_note
from public.readers r
join public.branches br on br.branch_id = r.branch_id
where public.is_admin();

-- ---------------------------------------------------------------------
-- BUSINESS LOGIC (each function = one transaction)
-- ---------------------------------------------------------------------
create function public.result(p_ok boolean, p_code text, p_message text) returns jsonb
language sql immutable as $$
  select jsonb_build_object('ok', p_ok, 'code', p_code, 'message', p_message)
$$;

-- BOOK (FR-01, FR-02, NFR-01). The session row is locked, so two people can't
-- take the last place at the same time.
create function public.book_session(p_session_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_member   public.members%rowtype;
  v_session  public.class_sessions%rowtype;
  v_existing public.bookings%rowtype;
  v_has_old  boolean;
  v_taken    int;
begin
  select * into v_member from public.members where auth_user_id = auth.uid();
  if not found then
    return public.result(false, 'not_signed_in', 'Please log in to book a class.');
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

-- CANCEL (FR-06). Free until 3 hours before start. Later than that the
-- booking fee is forfeited, and the caller must confirm (p_accept_fee = true).
create function public.cancel_booking(p_booking_id bigint, p_accept_fee boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_b     public.bookings%rowtype;
  v_start timestamptz;
  v_late  boolean;
begin
  select b.* into v_b
    from public.bookings b
    join public.members m on m.member_id = b.member_id
   where b.booking_id = p_booking_id and m.auth_user_id = auth.uid()
   for update of b;
  if not found then
    return public.result(false, 'booking_not_found', 'Booking not found.');
  end if;
  if v_b.booking_status <> 'Confirmed' then
    return public.result(false, 'not_cancellable', 'Only confirmed bookings can be cancelled.');
  end if;
  select start_time into v_start from public.class_sessions where session_id = v_b.session_id;
  if v_start <= now() then
    return public.result(false, 'class_started', 'This class has already started.');
  end if;

  v_late := v_start - now() < interval '3 hours';
  if v_late and not p_accept_fee then
    return public.result(false, 'late_cancel_needs_confirm',
      'The class starts in less than 3 hours. If you cancel, the booking fee will be forfeited.');
  end if;

  update public.bookings
     set booking_status = 'Cancelled', cancelled_at = now(), fee_forfeited = v_late
   where booking_id = p_booking_id;

  if v_late then
    return public.result(true, 'cancelled_fee_forfeited', 'Booking cancelled. The booking fee is forfeited.');
  end if;
  return public.result(true, 'cancelled', 'Booking cancelled. No fee charged.');
end $$;

-- CHECK-IN (spec's multi-step transaction): insert the log + mark Attended.
-- If either step fails, the whole function rolls back.
create function public.check_in_booking(p_booking_id bigint, p_reader_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_b      public.bookings%rowtype;
  v_branch bigint;
  v_reader public.readers%rowtype;
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

-- NO-SHOW: a booking still 'Confirmed' after its class has ended means the
-- member never checked in, so it becomes 'No-show' and the booking fee is
-- forfeited (same rule as a late cancellation). Only the time decides, so any
-- logged-in user may trigger it; the app calls it before reading bookings.
create function public.mark_no_shows() returns int
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

-- MANUAL CHECK-IN (Plan B when the NFC reader fails). Admin only; the class
-- must have started. Works for 'Confirmed' and for 'No-show' (the member did
-- come, the reader just didn't record it), so the forfeited fee is returned.
create function public.manual_check_in(p_booking_id bigint) returns jsonb
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

-- FR-07: remember the member's language for the next login.
create function public.set_my_language(p_lang text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if p_lang not in ('kk', 'en', 'ru') then
    return public.result(false, 'bad_language', 'Unsupported language.');
  end if;
  update public.members set preferred_language = p_lang where auth_user_id = auth.uid();
  return public.result(true, 'saved', 'Saved.');
end $$;

-- Admins may not remove their own Admin role by accident (avoids lock-out).
create function public.protect_own_admin_role() returns trigger
language plpgsql as $$
begin
  if old.auth_user_id = auth.uid() and old.role = 'Admin' and new.role <> 'Admin' then
    raise exception 'cannot_demote_self';
  end if;
  -- (auth.uid() is null for internal actions such as deleting an auth user)
  if auth.uid() is not null and new.auth_user_id is distinct from old.auth_user_id then
    raise exception 'cannot_change_login';
  end if;
  return new;
end $$;

create trigger trg_protect_admin
before update on public.members
for each row execute function public.protect_own_admin_role();

-- ---------------------------------------------------------------------
-- NEW USER -> MEMBER ROW (FR-04)
-- Registration sends name, surname, phone and language as user metadata.
-- DEMO DEFAULT: 30 days of membership. Change to your business rule.
-- ---------------------------------------------------------------------
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.members (auth_user_id, member_name, member_surname, membership_expiry,
                              phone_number, preferred_language)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data->>'member_name'), ''), 'Member'),
    coalesce(nullif(trim(new.raw_user_meta_data->>'member_surname'), ''), 'Member'),
    current_date + 30,
    new.raw_user_meta_data->>'phone_number',
    coalesce(nullif(new.raw_user_meta_data->>'preferred_language', ''), 'en')
  );
  return new;
end $$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- PERMISSIONS
-- ---------------------------------------------------------------------
revoke all on function public.book_session(bigint)                from public, anon;
revoke all on function public.cancel_booking(bigint, boolean)     from public, anon;
revoke all on function public.check_in_booking(bigint, text)      from public, anon;
revoke all on function public.set_my_language(text)               from public, anon;
revoke all on function public.mark_no_shows()                      from public, anon;
revoke all on function public.manual_check_in(bigint)               from public, anon;
grant execute on function public.book_session(bigint)             to authenticated;
grant execute on function public.cancel_booking(bigint, boolean)  to authenticated;
grant execute on function public.check_in_booking(bigint, text)   to authenticated;
grant execute on function public.set_my_language(text)            to authenticated;
grant execute on function public.mark_no_shows()                   to authenticated;
grant execute on function public.manual_check_in(bigint)            to authenticated;

revoke all on public.v_me, public.v_bookings, public.v_trainer_roster, public.v_readers from anon;
grant select on public.v_sessions, public.v_trainers to anon, authenticated;
grant select on public.v_me, public.v_bookings, public.v_trainer_roster, public.v_readers,
                public.v_attendance_report to authenticated;

-- Catalog tables: RLS above decides who may actually read/write.
revoke all on public.branches, public.rooms, public.trainers, public.classes, public.class_sessions,
              public.members, public.bookings, public.readers, public.check_in_logs from anon;
grant select on public.branches to anon;
grant select, insert, update, delete on public.branches, public.rooms, public.trainers,
             public.classes, public.class_sessions to authenticated;
grant select, update on public.members to authenticated;
grant select on public.readers to authenticated;
