# Payroll preview acceptance checklist

Status: test specification only. Run against an isolated staging database after the migrations have been reviewed and applied there. Do not insert fixtures into production.

## Calculation contract

For each employed calendar date:
- Daily rate = salary effective on that date / actual calendar days in the month.
- Monday-Saturday require approved attendance unless covered by approved paid leave or an approved explicit day override.
- Sundays and national Kenyan public holidays are paid by default, unless an approved `unpaid_absence` override exists.
- Regional holiday rows are not applied until staff-to-region mapping is implemented.
- Approved leave follows the effective-dated policy and its paid-day limit.
- Pending, rejected and cancelled attendance/leave/overrides do not count.
- Final basic pay is rounded once to the nearest whole shilling.
- Overtime and statutory deductions are outside this preview; they must not be silently included.

## Required test vectors

| Case | Fixture | Expected |
|---|---|---|
| Full month | Nov 2026, salary KSh 30,000, 30 paid days | 30 paid days; KSh 30,000 |
| Two weekday absences | Same month, 28 paid days | 28 paid days; KSh 28,000 |
| Sunday absence | Same month, 27 paid days after approved unpaid Sunday override | 27 paid days; KSh 27,000 |
| Mid-month joiner | Starts 11 Nov, every eligible date paid (20 dates) | 20 paid days; KSh 20,000 |
| 31-day month | Salary KSh 31,000, all 31 dates paid | KSh 31,000 |
| February | Salary KSh 28,000, all 28 dates paid | KSh 28,000 |
| Leap February | Salary KSh 29,000, all 29 dates paid | KSh 29,000 |
| Terminated employee | Employment ends mid-period; eligible days approved | Included only through end date |
| Salary change | Two effective salary periods in one month | Each date uses its effective salary; final total rounded once |
| Pending attendance | Weekday attendance pending | Excluded |
| Paid leave cap | Approved leave exceeds configured paid-day limit | Only days within the cap count |
| Missing leave policy | Approved leave type has no effective policy | Preview blocked with `leave_policy_required` |
| Cancelled leave | Cancelled approved leave | Excluded |
| Sunday/public holiday absence | Approved `unpaid_absence` override | Date excluded |
| Pending override | Override is pending | Default calendar treatment remains; override does not affect earnings |
| Duplicate approved override | Two approved overrides for same employee/date | Unique index rejects second |
| Regional holiday | Holiday has non-null region | Not applied until location mapping is built |

## Security checks

- A payroll manager can read preview and overrides.
- A non-payroll employee cannot read another employee's override records.
- A non-payroll user cannot create, approve, edit or delete overrides.
- Every approved override has a reason, approver and approval timestamp.
- Pending/rejected overrides cannot affect the preview.
- RLS is tested using separate authenticated roles in staging.

## Payroll integration gates

Do not connect this preview to payroll preparation until:
1. Company work calendar and leave policy records are approved and populated.
2. Public holidays are sourced from official gazette/authoritative notices and independently checked.
3. Statutory rules are configured from current official guidance and verified by the payroll adviser, including employee-specific reliefs and deductions.
4. Draft payroll snapshots preserve salary, paid-day breakdown, overtime, allowances and adjustments.
5. The existing maker-checker approval and finance posting path is verified unchanged.
6. Rerun prevention, locking, reversal and correction scenarios pass in staging.

## Known boundaries

This preview is not a statutory net-pay calculator, payslip generator, payroll run creator, or finance posting function. It is a read-only basic-pay preview. The legacy `payroll_prepare_run` still uses the legacy preview and the existing hard-coded statutory function; it must not be treated as using this v2 logic.
