ALTER FUNCTION public.is_full_admin() SET search_path = public, pg_temp;
ALTER FUNCTION public.write_management_audit_log(text,text,text,text,text,boolean) SET search_path = public, pg_temp;