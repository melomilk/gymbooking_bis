-- =====================================================================
-- TRAINER SIGN-UP (run ONCE in Supabase SQL Editor, after schema.sql and
-- migration_attendance.sql). Purely additive: no existing table, view or
-- function is changed, so the running site keeps working while you run it.
--
-- How it works:
--   * Everyone registers as a normal Member (handle_new_user is unchanged).
--   * A person who chose "Trainer" then sends an application with
--     certificates. The account stays 'Member' until an admin approves it,
--     so nobody can make themselves a Trainer.
--   * Approve -> a trainers row is created and the member becomes 'Trainer'
--     linked to it (same rule as members_check: Trainer needs trainer_id).
-- =====================================================================

-- ---------- 1. Table ----------
create table if not exists public.trainer_applications (
  application_id    bigint generated always as identity primary key,
  member_id         bigint not null references public.members(member_id) on delete cascade,
  email             varchar(150) not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  specialization    varchar(200) not null check (length(trim(specialization)) > 0),
  experience_years  int not null check (experience_years between 0 and 60),
  bio               text check (bio is null or length(bio) <= 2000),
  -- [{ "path": "<auth uid>/<file>", "name": "original name.pdf" }, ...]
  certificates      jsonb not null
                    check (jsonb_typeof(certificates) = 'array'
                           and jsonb_array_length(certificates) between 1 and 5),
  status            varchar(10) not null default 'Pending'
                    check (status in ('Pending', 'Approved', 'Rejected')),
  reject_reason     text,
  created_at        timestamptz not null default now(),
  reviewed_at       timestamptz,
  reviewed_by       bigint references public.members(member_id),
  trainer_id        bigint references public.trainers(trainer_id)
);

-- One open (Pending or Approved) application per member. After a rejection
-- the member may apply again.
create unique index if not exists trainer_applications_one_open
  on public.trainer_applications (member_id) where status in ('Pending', 'Approved');

-- No direct access: users read through the view, write through functions.
alter table public.trainer_applications enable row level security;
revoke all on public.trainer_applications from anon, authenticated;

-- ---------- 2. View: own applications for members, all for admins ----------
create or replace view public.v_trainer_applications as
select a.application_id, a.member_id,
       m.member_name || ' ' || m.member_surname as member_fullname, m.phone_number,
       a.email, a.specialization, a.experience_years, a.bio, a.certificates,
       a.status, a.reject_reason, a.created_at, a.reviewed_at, a.trainer_id
from public.trainer_applications a
join public.members m on m.member_id = a.member_id
where m.auth_user_id = auth.uid() or public.is_admin();

revoke all on public.v_trainer_applications from anon;
grant select on public.v_trainer_applications to authenticated;

-- ---------- 3. Submit (the applicant) ----------
create or replace function public.submit_trainer_application(
  p_email text, p_specialization text, p_experience_years int, p_bio text, p_certificates jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_member public.members%rowtype;
  v_cert   jsonb;
begin
  select * into v_member from public.members where auth_user_id = auth.uid();
  if not found then
    return public.result(false, 'not_signed_in', 'Please log in first.');
  end if;
  if v_member.role <> 'Member' then
    return public.result(false, 'already_trainer', 'Your account already has staff access.');
  end if;
  if exists (select 1 from public.trainer_applications
              where member_id = v_member.member_id and status in ('Pending', 'Approved')) then
    return public.result(false, 'application_exists', 'You already have an application under review.');
  end if;
  if coalesce(trim(p_email), '') !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    return public.result(false, 'invalid_email', 'Please enter a valid email.');
  end if;
  if coalesce(trim(p_specialization), '') = '' then
    return public.result(false, 'required', 'Please fill in all required fields.');
  end if;
  if p_experience_years is null or p_experience_years not between 0 and 60 then
    return public.result(false, 'invalid_value', 'Invalid value.');
  end if;
  if p_certificates is null or jsonb_typeof(p_certificates) <> 'array'
     or jsonb_array_length(p_certificates) not between 1 and 5 then
    return public.result(false, 'certificates_required', 'Attach 1 to 5 certificate files.');
  end if;
  -- every file must be in the caller's own storage folder
  for v_cert in select * from jsonb_array_elements(p_certificates) loop
    if coalesce(v_cert->>'path', '') not like auth.uid()::text || '/%' then
      return public.result(false, 'invalid_value', 'Invalid certificate file.');
    end if;
  end loop;

  insert into public.trainer_applications (member_id, email, specialization, experience_years, bio, certificates)
  values (v_member.member_id, trim(p_email), trim(p_specialization), p_experience_years,
          nullif(trim(coalesce(p_bio, '')), ''), p_certificates);
  return public.result(true, 'application_sent', 'Application sent. An administrator will review it.');
exception when unique_violation then
  return public.result(false, 'application_exists', 'You already have an application under review.');
end $$;

-- ---------- 4. Review (admin) ----------
create or replace function public.review_trainer_application(
  p_application_id bigint, p_approve boolean, p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_app     public.trainer_applications%rowtype;
  v_member  public.members%rowtype;
  v_admin   bigint;
  v_trainer bigint;
begin
  if not public.is_admin() then
    return public.result(false, 'admin_only', 'Only admins can do this.');
  end if;
  select member_id into v_admin from public.members where auth_user_id = auth.uid();

  select * into v_app from public.trainer_applications where application_id = p_application_id for update;
  if not found then
    return public.result(false, 'application_not_found', 'Application not found.');
  end if;
  if v_app.status <> 'Pending' then
    return public.result(false, 'application_not_pending', 'This application has already been reviewed.');
  end if;

  if not p_approve then
    update public.trainer_applications
       set status = 'Rejected', reject_reason = nullif(trim(coalesce(p_reason, '')), ''),
           reviewed_at = now(), reviewed_by = v_admin
     where application_id = p_application_id;
    return public.result(true, 'application_rejected', 'Application rejected.');
  end if;

  select * into v_member from public.members where member_id = v_app.member_id for update;
  if v_member.role <> 'Member' then
    return public.result(false, 'already_trainer', 'This account already has staff access.');
  end if;

  insert into public.trainers (trainer_name, phone, email)
  values (v_member.member_name || ' ' || v_member.member_surname, v_member.phone_number, v_app.email)
  returning trainer_id into v_trainer;

  update public.members set role = 'Trainer', trainer_id = v_trainer where member_id = v_member.member_id;

  update public.trainer_applications
     set status = 'Approved', reviewed_at = now(), reviewed_by = v_admin, trainer_id = v_trainer
   where application_id = p_application_id;
  return public.result(true, 'application_approved', 'Approved. The account is now a Trainer.');
end $$;

revoke all on function public.submit_trainer_application(text, text, int, text, jsonb) from public, anon;
revoke all on function public.review_trainer_application(bigint, boolean, text)       from public, anon;
grant execute on function public.submit_trainer_application(text, text, int, text, jsonb) to authenticated;
grant execute on function public.review_trainer_application(bigint, boolean, text)       to authenticated;

-- ---------- 5. Private storage bucket for certificates ----------
-- Files go to trainer-certificates/<auth uid>/<file>. Max 5 MB, PDF/JPG/PNG.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('trainer-certificates', 'trainer-certificates', false, 5242880,
        array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;

drop policy if exists "trainer certs: upload own" on storage.objects;
create policy "trainer certs: upload own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'trainer-certificates'
              and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "trainer certs: read own or admin" on storage.objects;
create policy "trainer certs: read own or admin" on storage.objects
  for select to authenticated
  using (bucket_id = 'trainer-certificates'
         and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));
