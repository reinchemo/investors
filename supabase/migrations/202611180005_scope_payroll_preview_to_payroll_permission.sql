-- The preview joins staff, attendance and leave tables whose RLS policies
-- are scoped to separate Staff, Attendance and Leave modules. A Payroll-only
-- manager must still be able to run this narrowly scoped payroll preview.
-- The function itself enforces authentication and Payroll view permission.
alter function public.payroll_month_preview_v2(text) security definer;
alter function public.payroll_month_preview_v2(text) set search_path = public, pg_temp;

revoke all on function public.payroll_month_preview_v2(text) from public, anon;
grant execute on function public.payroll_month_preview_v2(text) to authenticated;

comment on function public.payroll_month_preview_v2(text) is
'Scoped SECURITY DEFINER payroll preview. Requires an authenticated user with Payroll view permission; reads staff, attendance, leave, salary history and payroll configuration to return only the proposal-aligned payroll preview. No writes, statutory deductions or ledger posting.';
