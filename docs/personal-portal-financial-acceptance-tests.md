# Personal Portal financial records and access acceptance checks

## Security model
- The browser must not supply a staff ID or investor ID to retrieve financial records.
- The authenticated Supabase user is resolved by the Edge Function and mapped through exactly one active `personal_portal_accounts` row.
- Employee records are filtered by that account's `staff_id`; investor records and dividend allocations are filtered by its `investor_id`.
- Management pages, management permissions, payroll calculations, and the existing two-stage dividend formula are out of scope and must remain unchanged.

## Account classification test matrix

| Test identity | Account links | Expected portal access |
|---|---|---|
| Employee only | staff ID; no investor ID | Employee dashboard, attendance, leave, tasks, payslips; no investor data |
| Employee + investor | staff ID and investor ID | Both employee and investor modules in one login |
| Investor only | investor ID; no staff ID | Investments, dividends and investor statements; no employee data |
| Suspended | Any valid link; status suspended | All personal-data actions denied |
| Unlinked / invalid | No active mapping | All personal-data actions denied |

## Cross-account isolation checks
1. Sign in as Employee A and record the IDs returned by dashboard, leave, overtime and payslips.
2. Sign in as Employee B and confirm none of Employee A's records are returned.
3. Sign in as Investor A and record investment, share transaction and dividend IDs.
4. Sign in as Investor B and confirm none of Investor A's records or allocations are returned.
5. Attempt to pass another person's staff/investor ID in the request body; the endpoints must ignore it and continue using the server-side account mapping.
6. Attempt to mark another user's notification as read; the endpoint must return not found.
7. Suspend an account and confirm the backend returns 403 for all personal-data actions.
8. Confirm a combined account receives only the employee and investor records mapped to that same authenticated user.

## Financial document checks
- Payslips must include only payroll runs with `posted_at` set and `cancelled_at` unset.
- Payslip gross, deduction, net and component amounts must match the stored payroll item; the portal must not recalculate payroll.
- The payslip print view should support browser "Save as PDF" and individual payslip printing.
- Investor statement print view should respect the selected activity/date filters and support browser "Save as PDF".
- Dividend allocations must be taken from the stored distribution allocation for the authenticated investor; no frontend formula or recalculation is permitted.
- Paid and unpaid distribution statuses must be displayed distinctly. The live database currently contains paid dividend records only; pending amounts therefore remain zero until an unpaid distribution exists.

## Release verification
- Run the employee-only, combined, investor-only, two-employee and two-investor tests using dedicated non-production test accounts.
- Confirm no management dashboard or admin workflow files changed.
- Confirm GitHub Pages workflow publishes only the allowlisted Personal Portal files.
- Verify the deployed GitHub Pages site after the workflow completes.
