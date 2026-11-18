-- =====================================================================
-- Excused no-show. Run ONCE in the Supabase SQL editor after schema.sql
-- (on an older database: after migration_receptionist.sql and
-- migration_session_cancel.sql, because this replaces v_bookings).
--
-- A member missed a class for a valid reason (illness, family, work...).
-- The admin picks the reason; for illness a PDF medical note is required.
-- The booking becomes 'Cancelled' (so it no longer counts as a miss in the
-- attendance report or in "My progress") and the forfeited fee is returned.
-- "Mark attended" is NOT used for this: the member did not come.
--
--   1. bookings: excuse_reason, excuse_note, excuse_document, excused_at
--   2. Private storage bucket for the PDF notes
--   3. v_bookings shows the excuse columns
--   4. excuse_no_show(): admin only, only for 'No-show' bookings
-- =====================================================================

begin;

-- ---------- 1. columns ----------
alter table public.bookings
  add column if not exists excuse_reason   varchar(10)
    check (excuse_reason in ('Illness', 'Family', 'Work', 'Other')),
  add column if not exists excuse_note     varchar(500),
  add column if not exists excuse_document text,          -- path in the excuse-documents bucket
  add column if not exists excused_at      timestamptz;

-- ---------- 2. storage: excuse-documents/<booking_id>/<file>.pdf ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('excuse-documents', 'excuse-documents', false, 5242880, array['application/pdf'])
on conflict (id) do nothing;

drop policy if exists "excuse docs: admin upload" on storage.objects;
create policy "excuse docs: admin upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'excuse-documents' and public.is_admin());

drop policy if exists "excuse docs: admin delete" on storage.objects;
create policy "excuse docs: admin delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'excuse-documents' and public.is_admin());

-- the admin, or the member whose booking it is, may open the file
drop policy if exists "excuse docs: read admin or owner" on storage.objects;
create policy "excuse docs: read admin or owner" on storage.objects
  for select to authenticated
  using (bucket_id = 'excuse-documents'
         and (public.is_admin()
              or exists (select 1 from public.bookings b
                           join public.members m on m.member_id = b.member_id
                          where b.booking_id::text = (storage.foldername(name))[1]
                            and m.auth_user_id = auth.uid())));

-- ---------- 3. v_bookings + excuse columns (added at the end) ----------
create or replace view public.v_bookings as
select b.booking_id, b.member_id, b.session_id, b.booking_status, b.booking_time,
       b.cancelled_at, b.fee_forfeited,
       m.member_name || ' ' || m.member_surname as member_fullname,
       c.class_name, s.trainer_id, t.trainer_name, s.branch_id, br.branch_name, r.room_name,
       s.start_time, s.end_time, s.cancelled_at as session_cancelled_at,
       b.excuse_reason, b.excuse_note, b.excuse_document, b.excused_at
from public.bookings b
join public.members  m  on m.member_id  = b.member_id
join public.class_sessions s on s.session_id = b.session_id
join public.classes  c  on c.class_id   = s.class_id
join public.trainers t  on t.trainer_id = s.trainer_id
join public.branches br on br.branch_id = s.branch_id
join public.rooms    r  on r.room_id    = s.room_id
where m.auth_user_id = auth.uid() or public.is_staff();

-- ---------- 4. excuse_no_show() ----------
create or replace function public.excuse_no_show(
  p_booking_id bigint, p_reason text, p_note text, p_document text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_b    public.bookings%rowtype;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  if not public.is_admin() then
    return public.result(false, 'admin_only', 'Only admins can excuse a no-show.');
  end if;
  if p_reason is null or p_reason not in ('Illness', 'Family', 'Work', 'Other') then
    return public.result(false, 'invalid_reason', 'Choose a reason.');
  end if;
  if p_reason = 'Other' and v_note is null then
    return public.result(false, 'note_required', 'Describe the reason.');
  end if;
  if p_reason = 'Illness' and p_document is null then
    return public.result(false, 'document_required', 'Attach the medical note (PDF).');
  end if;
  -- the file must be in this booking's folder
  if p_document is not null and p_document not like p_booking_id::text || '/%' then
    return public.result(false, 'invalid_value', 'Invalid document.');
  end if;

  select * into v_b from public.bookings where booking_id = p_booking_id for update;
  if not found then
    return public.result(false, 'booking_not_found', 'Booking not found.');
  end if;
  if v_b.booking_status <> 'No-show' then
    return public.result(false, 'not_no_show', 'Only a no-show can be excused.');
  end if;

  update public.bookings
     set booking_status  = 'Cancelled',
         fee_forfeited   = false,          -- the fee is returned
         cancelled_at    = now(),
         excuse_reason   = p_reason,
         excuse_note     = left(v_note, 500),
         excuse_document = p_document,
         excused_at      = now()
   where booking_id = p_booking_id;
  return public.result(true, 'excused', 'No-show excused, fee returned.');
end $$;

revoke all on function public.excuse_no_show(bigint, text, text, text) from public, anon;
grant execute on function public.excuse_no_show(bigint, text, text, text) to authenticated;

commit;
