-- =====================================================================
-- CLASS REVIEWS AND TRAINER RATINGS. Run ONCE in the Supabase SQL Editor,
-- AFTER migration_points_rewards.sql (a review gives +5 Pulse points).
-- Purely additive: no existing table, view or function is changed.
--
-- Only a member who really came (booking 'Attended', i.e. checked in by NFC
-- or at the front desk) can rate the class: 1-5 stars and an optional comment,
-- from the end of the class for 14 days. The review can be edited in that time.
-- Trainers see the reviews of their own classes WITHOUT the member's name;
-- the admin sees names and can remove a review that breaks the rules.
-- =====================================================================

begin;

create table if not exists public.class_reviews (
  review_id   bigint generated always as identity primary key,
  booking_id  bigint not null unique references public.bookings(booking_id) on delete cascade,
  member_id   bigint not null references public.members(member_id) on delete cascade,
  session_id  bigint not null references public.class_sessions(session_id),
  trainer_id  bigint not null references public.trainers(trainer_id),
  rating      smallint not null check (rating between 1 and 5),
  comment     varchar(500),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists class_reviews_trainer on public.class_reviews (trainer_id);

alter table public.class_reviews enable row level security;
revoke all on public.class_reviews from anon, authenticated;

-- ---------- views ----------
-- public: average per trainer (shown in the schedule)
create or replace view public.v_trainer_ratings as
select t.trainer_id, t.trainer_name,
       round(avg(r.rating)::numeric, 1)::float8 as avg_rating, count(r.review_id)::int as reviews_count
from public.trainers t
join public.class_reviews r on r.trainer_id = t.trainer_id
group by t.trainer_id, t.trainer_name;

-- the member's own reviews (to show and edit them)
create or replace view public.v_my_reviews as
select r.review_id, r.booking_id, r.rating, r.comment, r.created_at, r.updated_at
from public.class_reviews r
join public.members m on m.member_id = r.member_id
where m.auth_user_id = auth.uid();

-- trainer: reviews of own classes, anonymous; admin: all, with names
create or replace view public.v_reviews as
select r.review_id, r.rating, r.comment, r.created_at, r.updated_at, r.trainer_id, t.trainer_name,
       c.class_name, s.start_time,
       case when public.is_admin() then m.member_name || ' ' || m.member_surname end as member_fullname
from public.class_reviews r
join public.members m on m.member_id = r.member_id
join public.trainers t on t.trainer_id = r.trainer_id
join public.class_sessions s on s.session_id = r.session_id
join public.classes c on c.class_id = s.class_id
where public.is_admin()
   or r.trainer_id = (select me.trainer_id from public.members me
                       where me.auth_user_id = auth.uid() and me.role = 'Trainer');

grant select on public.v_trainer_ratings to anon, authenticated;
revoke all on public.v_my_reviews, public.v_reviews from anon;
grant select on public.v_my_reviews, public.v_reviews to authenticated;

-- ---------- functions ----------
create or replace function public.submit_review(p_booking_id bigint, p_rating int, p_comment text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_b       public.bookings%rowtype;
  v_s       public.class_sessions%rowtype;
  v_comment text := nullif(trim(coalesce(p_comment, '')), '');
  v_new     boolean;
  v_added   int := 0;
begin
  select b.* into v_b from public.bookings b join public.members m on m.member_id = b.member_id
   where b.booking_id = p_booking_id and m.auth_user_id = auth.uid();
  if not found then
    return public.result(false, 'booking_not_found', 'Booking not found.');
  end if;
  if v_b.booking_status <> 'Attended' then
    return public.result(false, 'review_not_attended', 'Only classes you attended can be rated.');
  end if;
  select * into v_s from public.class_sessions where session_id = v_b.session_id;
  if v_s.end_time > now() then
    return public.result(false, 'review_too_early', 'You can rate the class after it ends.');
  end if;
  if now() - v_s.end_time > interval '14 days' then
    return public.result(false, 'review_too_late', 'Classes can be rated for 14 days.');
  end if;
  if p_rating is null or p_rating not between 1 and 5 then
    return public.result(false, 'invalid_rating', 'Choose from 1 to 5 stars.');
  end if;
  if length(coalesce(v_comment, '')) > 500 then
    return public.result(false, 'invalid_value', 'The comment is too long.');
  end if;

  v_new := not exists (select 1 from public.class_reviews where booking_id = p_booking_id);
  insert into public.class_reviews (booking_id, member_id, session_id, trainer_id, rating, comment)
  values (p_booking_id, v_b.member_id, v_s.session_id, v_s.trainer_id, p_rating, v_comment)
  on conflict (booking_id) do update
     set rating = excluded.rating, comment = excluded.comment, updated_at = now();

  if v_new then   -- points only once per class (not again after an admin removed the review)
    insert into public.points_ledger (member_id, delta, reason, booking_id)
    values (v_b.member_id, 5, 'review', p_booking_id)
    on conflict do nothing;
    get diagnostics v_added = row_count;
  end if;
  if v_added > 0 then
    return public.result(true, 'review_saved_points', 'Thank you! +5 points.');
  end if;
  return public.result(true, 'review_saved', 'Review updated.');
end $$;

-- admin removes a review that breaks the rules; its 5 points are taken back
create or replace function public.delete_review(p_review_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_r public.class_reviews%rowtype;
begin
  if not public.is_admin() then
    return public.result(false, 'admin_only', 'Only admins can do this.');
  end if;
  delete from public.class_reviews where review_id = p_review_id returning * into v_r;
  if not found then
    return public.result(false, 'review_not_found', 'Review not found.');
  end if;
  if exists (select 1 from public.points_ledger where booking_id = v_r.booking_id and reason = 'review') then
    insert into public.points_ledger (member_id, delta, reason, booking_id)
    values (v_r.member_id, -5, 'review_removed', v_r.booking_id)
    on conflict do nothing;
  end if;
  return public.result(true, 'review_deleted', 'Review removed.');
end $$;

revoke all on function public.submit_review(bigint, int, text) from public, anon;
revoke all on function public.delete_review(bigint)            from public, anon;
grant execute on function public.submit_review(bigint, int, text) to authenticated;
grant execute on function public.delete_review(bigint)            to authenticated;

commit;
