-- Explicitly remove anonymous RPC access from the read-only payroll preview.
revoke all on function public.payroll_month_preview_v2(text) from public, anon;
grant execute on function public.payroll_month_preview_v2(text) to authenticated;
