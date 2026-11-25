-- =====================================================================
-- MEMBERSHIP RENEWAL (imitation online payment).
-- Run ONCE in the Supabase SQL Editor for existing databases.
-- Purely additive: no new tables, no changes to existing tables or RLS.
-- Updates only membership_status and membership_expiry on public.members.
-- =====================================================================

begin;

create or replace function public.renew_membership(p_months int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_member public.members%rowtype;
  v_today  date := (now() at time zone 'Asia/Almaty')::date;
  v_base   date;
  v_expiry date;
begin
  select * into v_member from public.members where auth_user_id = auth.uid() for update;
  if not found then
    return public.result(false, 'not_signed_in', 'Please log in first.');
  end if;
  if v_member.role in ('Admin', 'Receptionist') then
    return public.result(false, 'staff_cannot_renew', 'Staff accounts do not have a membership to renew.');
  end if;
  if v_member.membership_status = 'Suspended' then
    return public.result(false, 'membership_suspended', 'Your membership is suspended. Please contact the front desk.');
  end if;
  if p_months not in (1, 3, 6) then
    return public.result(false, 'invalid_plan', 'Please choose a valid renewal plan.');
  end if;

  v_base := greatest(coalesce(v_member.membership_expiry, v_today), v_today);
  v_expiry := (v_base + make_interval(months => p_months))::date;

  update public.members
     set membership_status = 'Active',
         membership_expiry = v_expiry
   where member_id = v_member.member_id;

  return public.result(true, 'membership_renewed', 'Membership renewed!')
    || jsonb_build_object('membership_expiry', v_expiry);
end $$;

revoke all on function public.renew_membership(int) from public, anon;
grant execute on function public.renew_membership(int) to authenticated;

commit;
