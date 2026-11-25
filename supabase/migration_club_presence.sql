-- =====================================================================
-- RIGHT NOW IN THE CLUB: who is in the gym, club load, public profiles.
-- Run ONCE in the Supabase SQL Editor. Additive: two new columns, one new
-- table, new functions; v_me gets one extra column at the end.
--
-- The front desk (admin / receptionist) marks "arrived" and "left". A visit
-- without "left" counts as finished 3 hours after arrival (people forget to
-- sign out). The load level is the share of the branch's club_capacity:
-- below 40 % low, below 75 % medium, otherwise high (same as src/lib/club.ts).
-- Other members see only people who switched on "public profile" in My
-- Profile, and only when logged in; everyone else is just counted.
-- =====================================================================

begin;

alter table public.members  add column if not exists is_public boolean not null default false;
alter table public.branches add column if not exists club_capacity int not null default 60 check (club_capacity > 0);

create table if not exists public.club_visits (
  visit_id   bigint generated always as identity primary key,
  member_id  bigint not null references public.members(member_id) on delete cascade,
  branch_id  bigint not null references public.branches(branch_id),
  entered_at timestamptz not null default now(),
  left_at    timestamptz,
  marked_by  bigint references public.members(member_id) on delete set null,
  check (left_at is null or left_at >= entered_at)
);
-- a member is in at most one club at a time
create unique index if not exists club_visits_one_open on public.club_visits (member_id) where left_at is null;
create index if not exists club_visits_branch_open on public.club_visits (branch_id, entered_at) where left_at is null;

alter table public.club_visits enable row level security;
revoke all on public.club_visits from anon, authenticated;   -- only through the functions below

-- v_me + is_public (column added at the end, so "create or replace" works)
create or replace view public.v_me as
select m.member_id, m.member_name, m.member_surname, m.membership_status,
       m.membership_expiry, m.phone_number, m.role, m.trainer_id, m.preferred_language,
       case when m.membership_status = 'Suspended' then 'Suspended'
            when m.membership_expiry < current_date then 'Expired'
            else 'Active' end as effective_status,
       m.is_public
from public.members m
where m.auth_user_id = auth.uid();

-- ---------- helpers ----------
create or replace function public.visit_is_open(p_left timestamptz, p_entered timestamptz) returns boolean
language sql stable as $$
  select p_left is null and p_entered > now() - interval '3 hours'
$$;

create or replace function public.club_load(p_present int, p_capacity int) returns text
language sql immutable as $$
  select case when p_present::numeric / greatest(p_capacity, 1) >= 0.75 then 'high'
              when p_present::numeric / greatest(p_capacity, 1) >= 0.40 then 'medium'
              else 'low' end
$$;

-- ---------- public: the widget on the home page ----------
create or replace function public.club_now(p_branch_id bigint) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_cap     int;
  v_present int;
  v_people  jsonb := '[]'::jsonb;
begin
  select club_capacity into v_cap from public.branches where branch_id = p_branch_id;
  if not found then
    return null;
  end if;
  select count(*) into v_present from public.club_visits v
   where v.branch_id = p_branch_id and public.visit_is_open(v.left_at, v.entered_at);

  -- names only for logged-in users, and only of public profiles
  if auth.uid() is not null then
    select coalesce(jsonb_agg(to_jsonb(p) order by p.entered_at desc), '[]'::jsonb) into v_people
    from (
      select m.member_id,
             m.member_name || ' ' || left(m.member_surname, 1) || '.' as name,
             upper(left(m.member_name, 1) || left(m.member_surname, 1)) as initials,
             (select count(*) from public.club_visits x where x.member_id = m.member_id)::int as visits,
             v.entered_at
        from public.club_visits v
        join public.members m on m.member_id = v.member_id
       where v.branch_id = p_branch_id and public.visit_is_open(v.left_at, v.entered_at) and m.is_public
    ) p;
  end if;

  return jsonb_build_object('branch_id', p_branch_id, 'present', v_present, 'capacity', v_cap,
    'load', public.club_load(v_present, v_cap), 'people', v_people,
    'hidden', v_present - jsonb_array_length(v_people));
end $$;

-- another member's profile: only if public, only for logged-in users
create or replace function public.public_profile(p_member_id bigint) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_m           public.members%rowtype;
  v_open_at     timestamptz;
  v_open_branch text;
  v_month       timestamptz := date_trunc('month', now() at time zone 'Asia/Almaty') at time zone 'Asia/Almaty';
begin
  if auth.uid() is null then
    return null;
  end if;
  select * into v_m from public.members where member_id = p_member_id;
  if not found or not v_m.is_public then
    return null;
  end if;
  select v.entered_at, b.branch_name into v_open_at, v_open_branch
    from public.club_visits v join public.branches b on b.branch_id = v.branch_id
   where v.member_id = p_member_id and public.visit_is_open(v.left_at, v.entered_at)
   limit 1;

  return jsonb_build_object(
    'member_id', v_m.member_id,
    'name', v_m.member_name || ' ' || left(v_m.member_surname, 1) || '.',
    'initials', upper(left(v_m.member_name, 1) || left(v_m.member_surname, 1)),
    'visits_total', (select count(*) from public.club_visits where member_id = p_member_id),
    'visits_month', (select count(*) from public.club_visits where member_id = p_member_id and entered_at >= v_month),
    'first_visit', (select min(entered_at) from public.club_visits where member_id = p_member_id),
    'classes_attended', (select count(*) from public.bookings where member_id = p_member_id and booking_status = 'Attended'),
    'favourite_class', (select c.class_name
                          from public.bookings b
                          join public.class_sessions s on s.session_id = b.session_id
                          join public.classes c on c.class_id = s.class_id
                         where b.member_id = p_member_id and b.booking_status = 'Attended'
                         group by c.class_name order by count(*) desc, c.class_name limit 1),
    'in_club', case when v_open_at is null then null
                    else jsonb_build_object('branch_name', v_open_branch, 'entered_at', v_open_at) end);
end $$;

-- the member switches their own profile public / private
create or replace function public.set_profile_public(p_public boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  update public.members set is_public = coalesce(p_public, false) where auth_user_id = auth.uid();
  if not found then
    return public.result(false, 'not_signed_in', 'Please log in.');
  end if;
  if p_public then
    return public.result(true, 'profile_public_on', 'Your profile is public.');
  end if;
  return public.result(true, 'profile_public_off', 'Your profile is private.');
end $$;

-- ---------- front desk ----------
create or replace function public.staff_find_members(p_q text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_q      text := trim(coalesce(p_q, ''));
  v_digits text := regexp_replace(coalesce(p_q, ''), '\D', '', 'g');
begin
  if not public.is_staff() or v_q = '' then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(r) order by r.member_fullname)
    from (
      select m.member_id, m.member_name || ' ' || m.member_surname as member_fullname, m.phone_number,
             case when m.membership_status = 'Suspended' then 'Suspended'
                  when m.membership_expiry < (now() at time zone 'Asia/Almaty')::date then 'Expired'
                  else 'Active' end as effective_status,
             (select v.branch_id from public.club_visits v
               where v.member_id = m.member_id and public.visit_is_open(v.left_at, v.entered_at) limit 1) as in_club_branch_id
        from public.members m
       where m.role in ('Member', 'Trainer')
         and (strpos(lower(m.member_name || ' ' || m.member_surname), lower(v_q)) > 0
              or (length(v_digits) >= 3 and strpos(m.phone_number, v_digits) > 0))
       order by m.member_name, m.member_surname
       limit 10
    ) r), '[]'::jsonb);
end $$;

create or replace function public.club_visits_now(p_branch_id bigint) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_staff() then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'visit_id', v.visit_id, 'member_id', m.member_id,
             'member_fullname', m.member_name || ' ' || m.member_surname, 'phone_number', m.phone_number,
             'branch_id', v.branch_id, 'entered_at', v.entered_at, 'is_public', m.is_public)
           order by v.entered_at desc)
      from public.club_visits v
      join public.members m on m.member_id = v.member_id
     where v.branch_id = p_branch_id and public.visit_is_open(v.left_at, v.entered_at)), '[]'::jsonb);
end $$;

create or replace function public.visit_enter(p_member_id bigint, p_branch_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_m     public.members%rowtype;
  v_staff bigint;
begin
  if not public.is_staff() then
    return public.result(false, 'staff_only', 'Only the front desk can mark visits.');
  end if;
  if not exists (select 1 from public.branches where branch_id = p_branch_id) then
    return public.result(false, 'branch_not_found', 'Branch not found.');
  end if;
  -- lock the member so two clicks can't open two visits
  select * into v_m from public.members where member_id = p_member_id for update;
  if not found or v_m.role not in ('Member', 'Trainer') then
    return public.result(false, 'member_not_found', 'Member not found.');
  end if;
  if v_m.membership_status = 'Suspended' then
    return public.result(false, 'visit_membership_suspended', 'The membership is suspended.');
  end if;
  if v_m.membership_expiry < (now() at time zone 'Asia/Almaty')::date then
    return public.result(false, 'visit_membership_expired', 'The membership has expired.');
  end if;

  -- a forgotten "left" mark: the old visit ends 3 hours after arrival
  update public.club_visits set left_at = entered_at + interval '3 hours'
   where member_id = p_member_id and left_at is null and not public.visit_is_open(left_at, entered_at);
  if exists (select 1 from public.club_visits where member_id = p_member_id and left_at is null) then
    return public.result(false, 'already_in_club', 'This member is already in the club.');
  end if;

  select member_id into v_staff from public.members where auth_user_id = auth.uid();
  insert into public.club_visits (member_id, branch_id, marked_by) values (p_member_id, p_branch_id, v_staff);
  return public.result(true, 'visit_started', 'Arrival recorded.');
exception when unique_violation then
  return public.result(false, 'already_in_club', 'This member is already in the club.');
end $$;

create or replace function public.visit_leave(p_visit_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then
    return public.result(false, 'staff_only', 'Only the front desk can mark visits.');
  end if;
  update public.club_visits set left_at = now()
   where visit_id = p_visit_id and public.visit_is_open(left_at, entered_at);
  if not found then
    return public.result(false, 'visit_not_open', 'This visit is already over.');
  end if;
  return public.result(true, 'visit_ended', 'Departure recorded.');
end $$;

-- ---------- permissions ----------
revoke all on function public.club_now(bigint)               from public;
revoke all on function public.public_profile(bigint)         from public, anon;
revoke all on function public.set_profile_public(boolean)    from public, anon;
revoke all on function public.staff_find_members(text)       from public, anon;
revoke all on function public.club_visits_now(bigint)        from public, anon;
revoke all on function public.visit_enter(bigint, bigint)    from public, anon;
revoke all on function public.visit_leave(bigint)            from public, anon;
grant execute on function public.club_now(bigint)            to anon, authenticated;   -- count + load for everyone
grant execute on function public.public_profile(bigint)      to authenticated;
grant execute on function public.set_profile_public(boolean) to authenticated;
grant execute on function public.staff_find_members(text)    to authenticated;
grant execute on function public.club_visits_now(bigint)     to authenticated;
grant execute on function public.visit_enter(bigint, bigint) to authenticated;
grant execute on function public.visit_leave(bigint)         to authenticated;

commit;
