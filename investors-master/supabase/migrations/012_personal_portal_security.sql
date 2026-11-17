
BEGIN;

-- =========================================================
-- 1. SECURITY HELPER FUNCTIONS
-- =========================================================

CREATE OR REPLACE FUNCTION public.portal_account_is_active()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.personal_portal_accounts p
        WHERE p.user_id = auth.uid()
          AND p.account_status = 'active'
    );
$$;

CREATE OR REPLACE FUNCTION public.portal_my_staff_id()
RETURNS BIGINT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT p.staff_id
    FROM public.personal_portal_accounts p
    WHERE p.user_id = auth.uid()
      AND p.account_status = 'active'
      AND p.staff_id IS NOT NULL
    LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.portal_my_investor_id()
RETURNS BIGINT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT p.investor_id
    FROM public.personal_portal_accounts p
    WHERE p.user_id = auth.uid()
      AND p.account_status = 'active'
      AND p.investor_id IS NOT NULL
    LIMIT 1;
$$;

-- Checks one specific management permission.
CREATE OR REPLACE FUNCTION public.portal_management_has_permission(
    p_module TEXT,
    p_permission TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    permitted BOOLEAN := FALSE;
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN FALSE;
    END IF;

    IF public.is_full_admin() THEN
        RETURN TRUE;
    END IF;

    SELECT EXISTS (
        SELECT 1
        FROM public.user_roles ur
        JOIN public.roles r
          ON r.id = ur.role_id
        JOIN public.role_permissions rp
          ON rp.role_id = r.id
        WHERE ur.user_id = auth.uid()
          AND rp.module = p_module
          AND CASE p_permission
              WHEN 'view' THEN rp.can_view
              WHEN 'create' THEN rp.can_create
              WHEN 'edit' THEN rp.can_edit
              WHEN 'delete' THEN rp.can_delete
              WHEN 'approve' THEN rp.can_approve
              ELSE FALSE
          END = TRUE
    )
    INTO permitted;

    RETURN COALESCE(permitted, FALSE);
END;
$$;

CREATE OR REPLACE FUNCTION public.portal_management_can_view(
    p_module TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT public.portal_management_has_permission(p_module, 'view');
$$;

CREATE OR REPLACE FUNCTION public.portal_management_can_create(
    p_module TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT public.portal_management_has_permission(p_module, 'create');
$$;

CREATE OR REPLACE FUNCTION public.portal_management_can_edit(
    p_module TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT public.portal_management_has_permission(p_module, 'edit');
$$;

CREATE OR REPLACE FUNCTION public.portal_management_can_delete(
    p_module TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT public.portal_management_has_permission(p_module, 'delete');
$$;

REVOKE ALL ON FUNCTION public.portal_account_is_active() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.portal_my_staff_id() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.portal_my_investor_id() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.portal_management_has_permission(TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.portal_management_can_view(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.portal_management_can_create(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.portal_management_can_edit(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.portal_management_can_delete(TEXT) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.portal_account_is_active() TO authenticated;
GRANT EXECUTE ON FUNCTION public.portal_my_staff_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.portal_my_investor_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.portal_management_has_permission(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.portal_management_can_view(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.portal_management_can_create(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.portal_management_can_edit(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.portal_management_can_delete(TEXT) TO authenticated;


-- =========================================================
-- 2. ENABLE ROW LEVEL SECURITY
-- =========================================================

ALTER TABLE public.personal_portal_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.investors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.investments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.share_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dividends ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leave_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;


-- =========================================================
-- 3. STAFF
-- Employees can see their own staff record.
-- Management access follows Staff permissions.
-- =========================================================

DROP POLICY IF EXISTS portal_staff_select ON public.staff;
DROP POLICY IF EXISTS portal_staff_insert ON public.staff;
DROP POLICY IF EXISTS portal_staff_update ON public.staff;
DROP POLICY IF EXISTS portal_staff_delete ON public.staff;

CREATE POLICY portal_staff_select
ON public.staff FOR SELECT TO authenticated
USING (
    (
        public.portal_account_is_active()
        AND id = public.portal_my_staff_id()
    )
    OR public.portal_management_can_view('Staff')
);

CREATE POLICY portal_staff_insert
ON public.staff FOR INSERT TO authenticated
WITH CHECK (public.portal_management_can_create('Staff'));

CREATE POLICY portal_staff_update
ON public.staff FOR UPDATE TO authenticated
USING (public.portal_management_can_edit('Staff'))
WITH CHECK (public.portal_management_can_edit('Staff'));

CREATE POLICY portal_staff_delete
ON public.staff FOR DELETE TO authenticated
USING (public.portal_management_can_delete('Staff'));


-- =========================================================
-- 4. ATTENDANCE
-- Employees can view their own attendance.
-- Attendance changes remain management-controlled.
-- =========================================================

DROP POLICY IF EXISTS portal_attendance_select ON public.attendance;
DROP POLICY IF EXISTS portal_attendance_insert ON public.attendance;
DROP POLICY IF EXISTS portal_attendance_update ON public.attendance;
DROP POLICY IF EXISTS portal_attendance_delete ON public.attendance;

CREATE POLICY portal_attendance_select
ON public.attendance FOR SELECT TO authenticated
USING (
    (
        public.portal_account_is_active()
        AND staff_id = public.portal_my_staff_id()
    )
    OR public.portal_management_can_view('Attendance')
);

CREATE POLICY portal_attendance_insert
ON public.attendance FOR INSERT TO authenticated
WITH CHECK (public.portal_management_can_create('Attendance'));

CREATE POLICY portal_attendance_update
ON public.attendance FOR UPDATE TO authenticated
USING (public.portal_management_can_edit('Attendance'))
WITH CHECK (public.portal_management_can_edit('Attendance'));

CREATE POLICY portal_attendance_delete
ON public.attendance FOR DELETE TO authenticated
USING (public.portal_management_can_delete('Attendance'));


-- =========================================================
-- 5. PAYROLL ITEMS
-- Employees can see their own payroll items only.
-- =========================================================

DROP POLICY IF EXISTS portal_payroll_items_select ON public.payroll_items;
DROP POLICY IF EXISTS portal_payroll_items_insert ON public.payroll_items;
DROP POLICY IF EXISTS portal_payroll_items_update ON public.payroll_items;
DROP POLICY IF EXISTS portal_payroll_items_delete ON public.payroll_items;

CREATE POLICY portal_payroll_items_select
ON public.payroll_items FOR SELECT TO authenticated
USING (
    (
        public.portal_account_is_active()
        AND staff_id = public.portal_my_staff_id()
    )
    OR public.portal_management_can_view('Payroll')
);

CREATE POLICY portal_payroll_items_insert
ON public.payroll_items FOR INSERT TO authenticated
WITH CHECK (public.portal_management_can_create('Payroll'));

CREATE POLICY portal_payroll_items_update
ON public.payroll_items FOR UPDATE TO authenticated
USING (public.portal_management_can_edit('Payroll'))
WITH CHECK (public.portal_management_can_edit('Payroll'));

CREATE POLICY portal_payroll_items_delete
ON public.payroll_items FOR DELETE TO authenticated
USING (public.portal_management_can_delete('Payroll'));


-- =========================================================
-- 6. PAYROLL RUNS
-- Personal users cannot access company-wide payroll runs.
-- =========================================================

DROP POLICY IF EXISTS portal_payroll_runs_select ON public.payroll_runs;
DROP POLICY IF EXISTS portal_payroll_runs_insert ON public.payroll_runs;
DROP POLICY IF EXISTS portal_payroll_runs_update ON public.payroll_runs;
DROP POLICY IF EXISTS portal_payroll_runs_delete ON public.payroll_runs;

CREATE POLICY portal_payroll_runs_select
ON public.payroll_runs FOR SELECT TO authenticated
USING (public.portal_management_can_view('Payroll'));

CREATE POLICY portal_payroll_runs_insert
ON public.payroll_runs FOR INSERT TO authenticated
WITH CHECK (public.portal_management_can_create('Payroll'));

CREATE POLICY portal_payroll_runs_update
ON public.payroll_runs FOR UPDATE TO authenticated
USING (public.portal_management_can_edit('Payroll'))
WITH CHECK (public.portal_management_can_edit('Payroll'));

CREATE POLICY portal_payroll_runs_delete
ON public.payroll_runs FOR DELETE TO authenticated
USING (public.portal_management_can_delete('Payroll'));


-- =========================================================
-- 7. TASKS
-- Employees can see tasks assigned to their staff record.
-- Employee task updates will use a restricted server function
-- added in a later implementation step.
-- =========================================================

DROP POLICY IF EXISTS portal_tasks_select ON public.tasks;
DROP POLICY IF EXISTS portal_tasks_insert ON public.tasks;
DROP POLICY IF EXISTS portal_tasks_update ON public.tasks;
DROP POLICY IF EXISTS portal_tasks_delete ON public.tasks;

CREATE POLICY portal_tasks_select
ON public.tasks FOR SELECT TO authenticated
USING (
    (
        public.portal_account_is_active()
        AND assignee_staff_id = public.portal_my_staff_id()
    )
    OR public.portal_management_can_view('Tasks')
);

CREATE POLICY portal_tasks_insert
ON public.tasks FOR INSERT TO authenticated
WITH CHECK (public.portal_management_can_create('Tasks'));

CREATE POLICY portal_tasks_update
ON public.tasks FOR UPDATE TO authenticated
USING (public.portal_management_can_edit('Tasks'))
WITH CHECK (public.portal_management_can_edit('Tasks'));

CREATE POLICY portal_tasks_delete
ON public.tasks FOR DELETE TO authenticated
USING (public.portal_management_can_delete('Tasks'));


-- =========================================================
-- 8. INVESTORS
-- Investors can see their own investor record.
-- =========================================================

DROP POLICY IF EXISTS portal_investors_select ON public.investors;
DROP POLICY IF EXISTS portal_investors_insert ON public.investors;
DROP POLICY IF EXISTS portal_investors_update ON public.investors;
DROP POLICY IF EXISTS portal_investors_delete ON public.investors;

CREATE POLICY portal_investors_select
ON public.investors FOR SELECT TO authenticated
USING (
    (
        public.portal_account_is_active()
        AND id = public.portal_my_investor_id()
    )
    OR public.portal_management_can_view('Capitalization Table')
);

CREATE POLICY portal_investors_insert
ON public.investors FOR INSERT TO authenticated
WITH CHECK (public.portal_management_can_create('Capitalization Table'));

CREATE POLICY portal_investors_update
ON public.investors FOR UPDATE TO authenticated
USING (public.portal_management_can_edit('Capitalization Table'))
WITH CHECK (public.portal_management_can_edit('Capitalization Table'));

CREATE POLICY portal_investors_delete
ON public.investors FOR DELETE TO authenticated
USING (public.portal_management_can_delete('Capitalization Table'));


-- =========================================================
-- 9. INVESTMENTS
-- Investors can see their own investment transactions.
-- =========================================================

DROP POLICY IF EXISTS portal_investments_select ON public.investments;
DROP POLICY IF EXISTS portal_investments_insert ON public.investments;
DROP POLICY IF EXISTS portal_investments_update ON public.investments;
DROP POLICY IF EXISTS portal_investments_delete ON public.investments;

CREATE POLICY portal_investments_select
ON public.investments FOR SELECT TO authenticated
USING (
    (
        public.portal_account_is_active()
        AND investor_id = public.portal_my_investor_id()
    )
    OR public.portal_management_can_view('Share Ledger')
);

CREATE POLICY portal_investments_insert
ON public.investments FOR INSERT TO authenticated
WITH CHECK (public.portal_management_can_create('Share Ledger'));

CREATE POLICY portal_investments_update
ON public.investments FOR UPDATE TO authenticated
USING (public.portal_management_can_edit('Share Ledger'))
WITH CHECK (public.portal_management_can_edit('Share Ledger'));

CREATE POLICY portal_investments_delete
ON public.investments FOR DELETE TO authenticated
USING (public.portal_management_can_delete('Share Ledger'));


-- =========================================================
-- 10. SHARE TRANSACTIONS
-- Investors can see their own share transaction history.
-- They cannot change their equity or ownership.
-- =========================================================

DROP POLICY IF EXISTS portal_share_transactions_select ON public.share_transactions;
DROP POLICY IF EXISTS portal_share_transactions_insert ON public.share_transactions;
DROP POLICY IF EXISTS portal_share_transactions_update ON public.share_transactions;
DROP POLICY IF EXISTS portal_share_transactions_delete ON public.share_transactions;

CREATE POLICY portal_share_transactions_select
ON public.share_transactions FOR SELECT TO authenticated
USING (
    (
        public.portal_account_is_active()
        AND investor_id = public.portal_my_investor_id()
    )
    OR public.portal_management_can_view('Share Ledger')
);

CREATE POLICY portal_share_transactions_insert
ON public.share_transactions FOR INSERT TO authenticated
WITH CHECK (public.portal_management_can_create('Share Ledger'));

CREATE POLICY portal_share_transactions_update
ON public.share_transactions FOR UPDATE TO authenticated
USING (public.portal_management_can_edit('Share Ledger'))
WITH CHECK (public.portal_management_can_edit('Share Ledger'));

CREATE POLICY portal_share_transactions_delete
ON public.share_transactions FOR DELETE TO authenticated
USING (public.portal_management_can_delete('Share Ledger'));


-- =========================================================
-- 11. DIVIDENDS
-- Personal dividend allocations will be delivered through
-- a restricted function, not direct access to company-wide
-- dividend allocation records.
-- =========================================================

DROP POLICY IF EXISTS portal_dividends_select ON public.dividends;
DROP POLICY IF EXISTS portal_dividends_insert ON public.dividends;
DROP POLICY IF EXISTS portal_dividends_update ON public.dividends;
DROP POLICY IF EXISTS portal_dividends_delete ON public.dividends;

CREATE POLICY portal_dividends_select
ON public.dividends FOR SELECT TO authenticated
USING (
    public.portal_management_can_view('Distributions')
    OR public.portal_management_can_view('Dividend Declaration')
);

CREATE POLICY portal_dividends_insert
ON public.dividends FOR INSERT TO authenticated
WITH CHECK (
    public.portal_management_can_create('Distributions')
    OR public.portal_management_can_create('Dividend Declaration')
);

CREATE POLICY portal_dividends_update
ON public.dividends FOR UPDATE TO authenticated
USING (
    public.portal_management_can_edit('Distributions')
    OR public.portal_management_can_edit('Dividend Declaration')
)
WITH CHECK (
    public.portal_management_can_edit('Distributions')
    OR public.portal_management_can_edit('Dividend Declaration')
);

CREATE POLICY portal_dividends_delete
ON public.dividends FOR DELETE TO authenticated
USING (
    public.portal_management_can_delete('Distributions')
    OR public.portal_management_can_delete('Dividend Declaration')
);


-- =========================================================
-- 12. LEAVE REQUESTS
-- Employees can view their own requests and submit pending
-- requests. Management access follows Leave permissions.
-- =========================================================

DROP POLICY IF EXISTS portal_leave_select ON public.leave_requests;
DROP POLICY IF EXISTS portal_leave_insert ON public.leave_requests;
DROP POLICY IF EXISTS portal_leave_update ON public.leave_requests;
DROP POLICY IF EXISTS portal_leave_delete ON public.leave_requests;

CREATE POLICY portal_leave_select
ON public.leave_requests FOR SELECT TO authenticated
USING (
    (
        public.portal_account_is_active()
        AND staff_id = public.portal_my_staff_id()
    )
    OR public.portal_management_can_view('Leave')
);

CREATE POLICY portal_leave_insert
ON public.leave_requests FOR INSERT TO authenticated
WITH CHECK (
    (
        public.portal_account_is_active()
        AND staff_id = public.portal_my_staff_id()
        AND status = 'pending'
    )
    OR public.portal_management_can_create('Leave')
);

CREATE POLICY portal_leave_update
ON public.leave_requests FOR UPDATE TO authenticated
USING (public.portal_management_can_edit('Leave'))
WITH CHECK (public.portal_management_can_edit('Leave'));

CREATE POLICY portal_leave_delete
ON public.leave_requests FOR DELETE TO authenticated
USING (public.portal_management_can_delete('Leave'));


-- =========================================================
-- 13. AUDIT LOG
-- Management users with audit viewing permission can read.
-- No ordinary user update/delete policy is created.
-- =========================================================

DROP POLICY IF EXISTS portal_audit_log_select ON public.audit_log;

CREATE POLICY portal_audit_log_select
ON public.audit_log FOR SELECT TO authenticated
USING (
    public.portal_management_can_view('Audit Log')
);

COMMIT;
