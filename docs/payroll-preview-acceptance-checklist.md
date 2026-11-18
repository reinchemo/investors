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


## Additional leave/calendar regression cases
- A Sunday inside an approved leave interval remains an ordinary paid Sunday unless an approved day override marks it unpaid.
- A configured public holiday inside an approved leave interval remains an ordinary paid public holiday unless an approved day override marks it unpaid.
- Sundays and public holidays do not consume a paid-leave day limit.
- Paid-leave totals count only paid leave dates that are not Sundays or configured public holidays.
- An unpaid leave policy on a weekday does not turn a Sunday or public holiday into an unpaid day.
- An approved leave interval containing only Sundays/public holidays does not require a leave-pay policy for those calendar dates and does not block the preview.
- Two overlapping approved leave requests for the same employee/date block the preview with `overlapping_leave_requests`; the system must not silently choose one request.
- Override creation records the authenticated creator and starts in pending status; clients cannot submit pre-approved overrides.
- Only a different Payroll editor can approve/reject a pending override through `review_payroll_day_override`; the creator cannot approve their own request.
- Direct authenticated table updates and deletes are denied so approval metadata and audit history cannot be rewritten or erased through the table API.
- The review RPC rejects invalid decisions and attempts to review an override that is no longer pending.
- Overlapping effective-dated salary-history rows for the same employee/date block the preview with `overlapping_salary_history`; the newest row must not be silently selected.
- Overlapping active leave-pay policy rows for the same leave type/date block the preview with `overlapping_leave_policies`; policy precedence must be corrected by management rather than guessed.
- The creator can cancel their own pending override through `cancel_payroll_day_override`; a Payroll editor can cancel another user's pending request.
- The cancellation RPC rejects missing IDs and any request that has already been approved, rejected or cancelled.
- Cancelling a pending override records the authenticated actor and timestamp; cancelled overrides do not affect preview earnings.
- A pending override with a missing creator is rejected by both review and cancellation RPCs and requires manual audit.
- Run `docs/payroll-preview-readonly-preflight.sql` in isolated staging after both payroll migrations; resolve all overlap/date anomalies and confirm the RPC grants before functional tests.
