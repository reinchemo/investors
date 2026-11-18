-- STARLINK payroll preview: read-only preflight checks
-- Run only after migrations 202611180001 and 202611180002 have been
-- applied to an isolated staging database. Every statement is SELECT-only.
-- Do not run fixture inserts or DDL against production.

-- 1) Staff status/date integrity. Terminated staff must have an end date.
select status,
       count(*) as staff_count,
       count(*) filter (where start_date is null) as missing_start_dates,
       count(*) filter (where status = 'terminated' and end_date is null) as terminated_without_end_date
from public.staff
where deleted_at is null
group by status
order by status;

-- 2) Overlapping salary-history periods for the same employee.
select a.staff_id, a.id as first_history_id, b.id as second_history_id,
       a.effective_from as first_from, a.effective_to as first_to,
       b.effective_from as second_from, b.effective_to as second_to
from public.staff_salary_history a
join public.staff_salary_history b
  on b.staff_id = a.staff_id and b.id > a.id
 and daterange(a.effective_from, coalesce(a.effective_to, 'infinity'::date), '[]')
     && daterange(b.effective_from, coalesce(b.effective_to, 'infinity'::date), '[]')
order by a.staff_id, a.effective_from;

-- 3) Overlapping active leave-pay policies for the same leave type.
select a.leave_type, a.id as first_policy_id, b.id as second_policy_id,
       a.effective_from as first_from, a.effective_to as first_to,
       b.effective_from as second_from, b.effective_to as second_to
from public.payroll_leave_pay_policies a
join public.payroll_leave_pay_policies b
  on lower(b.leave_type) = lower(a.leave_type)
 and b.id > a.id
 and b.is_active
 and daterange(a.effective_from, coalesce(a.effective_to, 'infinity'::date), '[]')
     && daterange(b.effective_from, coalesce(b.effective_to, 'infinity'::date), '[]')
where a.is_active
order by lower(a.leave_type), a.effective_from;

-- 4) Overlapping approved leave requests for the same employee.
select a.staff_id, a.id as first_leave_id, b.id as second_leave_id,
       a.start_date as first_start, a.end_date as first_end,
       b.start_date as second_start, b.end_date as second_end
from public.leave_requests a
join public.leave_requests b
  on b.staff_id = a.staff_id and b.id > a.id
 and daterange(a.start_date, a.end_date, '[]')
     && daterange(b.start_date, b.end_date, '[]')
where a.status = 'approved' and b.status = 'approved'
  and a.cancelled_at is null and b.cancelled_at is null
order by a.staff_id, a.start_date;

-- 5) Duplicate approved day overrides (the partial unique index should
-- prevent these; this query is retained as a verification check).
select staff_id, pay_date, count(*) as approved_override_count
from public.payroll_day_overrides
where status = 'approved'
group by staff_id, pay_date
having count(*) > 1;

-- 6) Confirm the two RPCs are executable by authenticated and not PUBLIC.
select p.proname,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_can_execute,
       exists (
         select 1
         from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
         where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
       ) as public_can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('review_payroll_day_override', 'cancel_payroll_day_override',
                    'payroll_month_preview_v2')
order by p.proname;

-- 7) Direct UPDATE/DELETE policies must not exist for day overrides.
select policyname, cmd
from pg_policies
where schemaname = 'public'
  and tablename = 'payroll_day_overrides'
  and cmd in ('UPDATE','DELETE')
order by cmd, policyname;

-- Expected: queries 2-5 return zero rows; query 6 returns authenticated=true,
-- public=false for all three RPCs; query 7 returns zero rows. Any anomaly
-- requires review before preview is enabled. This script does not prove RLS
-- isolation; test with separate authenticated user sessions in staging.
