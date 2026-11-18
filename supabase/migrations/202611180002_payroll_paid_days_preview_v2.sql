-- Payroll preview v2: proposal-aligned paid-day calculation.
-- Development branch only. Do not apply until policy owners approve the
-- holiday calendar and leave-pay classifications.

create or replace function public.payroll_month_preview(p_period text)
returns table(
  staff_id bigint,
  employee_number text,
  employee_name text,
  monthly_salary numeric,
  calendar_days integer,
  approved_attendance_days bigint,
  calculated_basic_pay numeric,
  calculation_status text
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $function$
declare
  v_month_start date;
  v_month_end date;
  v_days integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.portal_management_can_view('Payroll') then
    raise exception 'You do not have permission to view payroll';
  end if;
  if p_period !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'Period must use YYYY-MM format';
  end if;

  v_month_start := to_date(p_period || '-01','YYYY-MM-DD');
  v_month_end := (v_month_start + interval '1 month - 1 day')::date;
  v_days := extract(day from v_month_end)::integer;

  return query
  with active_staff as (
    select s.id, s.employee_number, s.full_name, s.salary,
      greatest(coalesce(s.start_date,v_month_start),v_month_start) as eligible_from,
      least(coalesce(s.end_date,v_month_end),v_month_end) as eligible_to
    from public.staff s
    where s.status in ('active','terminated')
      and s.deleted_at is null
      and coalesce(s.start_date,v_month_start)<=v_month_end
      and coalesce(s.end_date,v_month_end)>=v_month_start
  ),
  days as (
    select a.id as staff_id, d::date as pay_date,
      extract(isodow from d)::integer=7 as is_sunday,
      exists (
        select 1 from public.payroll_public_holidays h
        where h.is_active and h.country_code='KE' and h.holiday_date=d::date
      ) as is_holiday,
      exists (
        select 1 from public.attendance at
        where at.staff_id=a.id and at.date=d::date and at.status='approved'
      ) as has_approved_attendance,
      (
        select lr.id
        from public.leave_requests lr
        where lr.staff_id=a.id and lr.status='approved'
          and lr.cancelled_at is null
          and d::date between lr.start_date and lr.end_date
        order by lr.created_at desc, lr.id desc
        limit 1
      ) as approved_leave_id,
      (
        select lr.leave_type
        from public.leave_requests lr
        where lr.staff_id=a.id and lr.status='approved'
          and lr.cancelled_at is null
          and d::date between lr.start_date and lr.end_date
        order by lr.created_at desc, lr.id desc
        limit 1
      ) as approved_leave_type
    from active_staff a
    cross join lateral generate_series(a.eligible_from,a.eligible_to,interval '1 day') d
  ),
  leave_policy as (
    select d.*,
      p.id as leave_policy_id,
      p.is_paid as leave_is_paid,
      p.paid_day_limit
    from days d
    left join lateral (
      select pol.id,pol.is_paid,pol.paid_day_limit
      from public.payroll_leave_pay_policies pol
      where d.approved_leave_type is not null
        and pol.is_active
        and lower(pol.leave_type)=lower(d.approved_leave_type)
        and pol.effective_from<=d.pay_date
        and (pol.effective_to is null or pol.effective_to>=d.pay_date)
      order by pol.effective_from desc,pol.id desc
      limit 1
    ) p on true
  ),
  classified as (
    select lp.*,
      case
        when lp.approved_leave_id is null then null
        when lp.leave_is_paid is distinct from true then false
        when lp.paid_day_limit is null then true
        else row_number() over (
          partition by lp.approved_leave_id
          order by lp.pay_date
        ) <= lp.paid_day_limit
      end as leave_day_is_paid
    from leave_policy lp
  ),
  rates as (
    select c.*,
      coalesce((
        select h.monthly_salary
        from public.staff_salary_history h
        where h.staff_id=c.staff_id
          and h.effective_from<=c.pay_date
          and (h.effective_to is null or h.effective_to>=c.pay_date)
        order by h.effective_from desc,h.id desc
        limit 1
      ), a.salary) as daily_monthly_salary
    from classified c
    join active_staff a on a.id=c.staff_id
  ),
  totals as (
    select r.staff_id,
      count(*) filter(where r.has_approved_attendance)::bigint as attendance_days,
      bool_or(r.daily_monthly_salary is null or r.daily_monthly_salary<=0) as missing_salary,
      bool_or(r.approved_leave_type is not null and r.leave_policy_id is null) as missing_leave_policy,
      sum(
        case
          when r.approved_leave_type is not null then
            case when r.leave_day_is_paid then coalesce(r.daily_monthly_salary,0)/v_days else 0 end
          when r.is_sunday or r.is_holiday or r.has_approved_attendance then
            coalesce(r.daily_monthly_salary,0)/v_days
          else 0
        end
      ) as earned
    from rates r
    group by r.staff_id
  ),
  salary_label as (
    select a.id,
      coalesce((
        select h.monthly_salary
        from public.staff_salary_history h
        where h.staff_id=a.id
          and h.effective_from<=v_month_end
          and (h.effective_to is null or h.effective_to>=v_month_end)
        order by h.effective_from desc,h.id desc
        limit 1
      ),a.salary) as month_salary
    from active_staff a
  )
  select a.id,a.employee_number,a.full_name,sl.month_salary,v_days,
    coalesce(t.attendance_days,0),
    case
      when coalesce(t.missing_salary,true) then null
      when coalesce(t.missing_leave_policy,false) then null
      else round(coalesce(t.earned,0),0)
    end,
    case
      when coalesce(t.missing_salary,true) then 'salary_required'
      when coalesce(t.missing_leave_policy,false) then 'leave_policy_required'
      when coalesce(t.earned,0)=0 then 'no_eligible_paid_days'
      else 'preview_only'
    end
  from active_staff a
  join totals t on t.staff_id=a.id
  join salary_label sl on sl.id=a.id
  order by a.full_name;
end;
$function$;

comment on function public.payroll_month_preview(text) is
'Proposal-aligned preview: daily salary divided by actual calendar days; eligible dates include approved attendance, Sundays, configured Kenyan public holidays and approved paid leave subject to configured paid-day limits. Missing salary or leave policy blocks a payable preview. Does not post payroll or apply statutory deductions.';
