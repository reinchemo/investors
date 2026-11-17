
BEGIN;

-- One authenticated account can link to one employee record,
-- one investor record, or both.

CREATE TABLE IF NOT EXISTS public.personal_portal_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL UNIQUE
        REFERENCES auth.users(id) ON DELETE CASCADE,

    staff_id BIGINT UNIQUE
        REFERENCES public.staff(id) ON DELETE RESTRICT,

    investor_id BIGINT UNIQUE
        REFERENCES public.investors(id) ON DELETE RESTRICT,

    account_status TEXT NOT NULL DEFAULT 'active'
        CHECK (account_status IN ('active', 'suspended')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT personal_portal_requires_link
        CHECK (staff_id IS NOT NULL OR investor_id IS NOT NULL)
);

-- Indexes for account lookup.
CREATE INDEX IF NOT EXISTS
    personal_portal_accounts_user_id_idx
ON public.personal_portal_accounts(user_id);

CREATE INDEX IF NOT EXISTS
    personal_portal_accounts_staff_id_idx
ON public.personal_portal_accounts(staff_id)
WHERE staff_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS
    personal_portal_accounts_investor_id_idx
ON public.personal_portal_accounts(investor_id)
WHERE investor_id IS NOT NULL;

-- Enable database-level protection.
ALTER TABLE public.personal_portal_accounts
ENABLE ROW LEVEL SECURITY;

-- Users may read only their own portal account.
DROP POLICY IF EXISTS
    "Users can view their own portal account"
ON public.personal_portal_accounts;

CREATE POLICY "Users can view their own portal account"
ON public.personal_portal_accounts
FOR SELECT
TO authenticated
USING (user_id = (SELECT auth.uid()));

COMMIT;

