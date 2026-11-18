-- =====================================================================
-- Edit a trainer application while it is still under review
-- (manual test table, case 16). Run ONCE in the Supabase SQL editor,
-- after migration_trainer_signup.sql. Purely additive.
--
-- update_trainer_application(): the applicant replaces their PENDING
-- application with a corrected version (same checks as submitting). Files
-- the applicant removed stay in storage but are no longer linked to it.
-- Once an admin has approved or rejected it, it can't be edited.
-- =====================================================================

create or replace function public.update_trainer_application(
  p_email text, p_specialization text, p_experience_years int, p_bio text, p_certificates jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_member public.members%rowtype;
  v_app    public.trainer_applications%rowtype;
  v_cert   jsonb;
begin
  select * into v_member from public.members where auth_user_id = auth.uid();
  if not found then
    return public.result(false, 'not_signed_in', 'Please log in first.');
  end if;
  -- locked, so an admin can't approve the old version while it is being replaced
  select * into v_app from public.trainer_applications
   where member_id = v_member.member_id and status = 'Pending'
   for update;
  if not found then
    return public.result(false, 'application_not_pending', 'This application has already been reviewed, so it can''t be edited.');
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
  if p_bio is not null and length(p_bio) > 2000 then
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

  update public.trainer_applications
     set email = trim(p_email), specialization = trim(p_specialization),
         experience_years = p_experience_years, bio = nullif(trim(coalesce(p_bio, '')), ''),
         certificates = p_certificates,
         created_at = now()   -- the admin sees when the latest version was sent
   where application_id = v_app.application_id;
  return public.result(true, 'application_updated', 'Application updated. An administrator will review the new version.');
end $$;

revoke all on function public.update_trainer_application(text, text, int, text, jsonb) from public, anon;
grant execute on function public.update_trainer_application(text, text, int, text, jsonb) to authenticated;
