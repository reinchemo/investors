ALTER TABLE public.personal_portal_accounts
  ADD COLUMN IF NOT EXISTS funder_id bigint REFERENCES public.funding_parties(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS personal_portal_accounts_funder_id_unique
  ON public.personal_portal_accounts(funder_id) WHERE funder_id IS NOT NULL;
ALTER TABLE public.personal_portal_accounts DROP CONSTRAINT IF EXISTS personal_portal_requires_link;
ALTER TABLE public.personal_portal_accounts ADD CONSTRAINT personal_portal_requires_link
  CHECK (staff_id IS NOT NULL OR investor_id IS NOT NULL OR funder_id IS NOT NULL);
