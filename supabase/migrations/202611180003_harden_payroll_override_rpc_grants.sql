-- Harden payroll day-override RPC grants and insert-policy evaluation.
-- The Supabase project has explicit anon EXECUTE defaults; revoke anon directly.

revoke all on function public.review_payroll_day_override(bigint,text) from public, anon;
grant execute on function public.review_payroll_day_override(bigint,text) to authenticated;

revoke all on function public.cancel_payroll_day_override(bigint) from public, anon;
grant execute on function public.cancel_payroll_day_override(bigint) to authenticated;

drop policy if exists payroll_day_overrides_insert on public.payroll_day_overrides;
create policy payroll_day_overrides_insert
  on public.payroll_day_overrides
  for insert to authenticated
  with check (
    (select public.portal_management_can_create('Payroll'))
    and created_by = (select auth.uid())
    and status = 'pending'
    and approved_by is null
    and approved_at is null
  );
