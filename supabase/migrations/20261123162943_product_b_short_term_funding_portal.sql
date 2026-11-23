-- Product B: short-term funding terms, investor linkage, secure document metadata and immutable agreements.
ALTER TABLE public.funding_opportunities
  ADD COLUMN IF NOT EXISTS funding_purpose text,
  ADD COLUMN IF NOT EXISTS minimum_commitment numeric(14,2) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS maximum_commitment numeric(14,2),
  ADD COLUMN IF NOT EXISTS return_type text NOT NULL DEFAULT 'fixed_total_period',
  ADD COLUMN IF NOT EXISTS day_count_basis text NOT NULL DEFAULT 'actual_365',
  ADD COLUMN IF NOT EXISTS eligibility jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS required_documents jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS tax_rate numeric(8,4),
  ADD COLUMN IF NOT EXISTS tax_approval_reference text,
  ADD COLUMN IF NOT EXISTS management_approval_reference text,
  ADD COLUMN IF NOT EXISTS terms_approval_reference text,
  ADD COLUMN IF NOT EXISTS terms_approved_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS terms_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS legal_gate_cleared_at timestamptz,
  ADD COLUMN IF NOT EXISTS legal_gate_cleared_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS capacity_reserved numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS terms_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS early_settlement_allowed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS compounding_allowed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS other_deductions jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.funding_opportunities
  DROP CONSTRAINT IF EXISTS funding_opportunities_return_type_check,
  ADD CONSTRAINT funding_opportunities_return_type_check CHECK (return_type IN ('fixed_total_period','annualised_simple')),
  DROP CONSTRAINT IF EXISTS funding_opportunities_day_count_basis_check,
  ADD CONSTRAINT funding_opportunities_day_count_basis_check CHECK (day_count_basis IN ('actual_365','actual_360','30_360')),
  DROP CONSTRAINT IF EXISTS funding_opportunities_commitment_range_check,
  ADD CONSTRAINT funding_opportunities_commitment_range_check CHECK (minimum_commitment > 0 AND (maximum_commitment IS NULL OR maximum_commitment >= minimum_commitment)),
  DROP CONSTRAINT IF EXISTS funding_opportunities_live_legal_gate_check,
  ADD CONSTRAINT funding_opportunities_live_legal_gate_check CHECK (status <> 'open' OR (legal_gate_cleared_at IS NOT NULL AND legal_approval_reference IS NOT NULL AND finance_approval_reference IS NOT NULL AND terms_approved_at IS NOT NULL AND proposed_return_rate IS NOT NULL AND term_days IS NOT NULL));
ALTER TABLE public.funding_parties
  ADD COLUMN IF NOT EXISTS investor_id bigint REFERENCES public.investors(id),
  ADD COLUMN IF NOT EXISTS beneficial_ownership jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS payment_account jsonb,
  ADD COLUMN IF NOT EXISTS consent_records jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS kyc_reviewed_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS kyc_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS kyc_decision_reason text,
  ADD COLUMN IF NOT EXISTS rejection_reason text,
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS funding_parties_investor_id_unique ON public.funding_parties(investor_id) WHERE investor_id IS NOT NULL;
ALTER TABLE public.funding_commitments
  ADD COLUMN IF NOT EXISTS return_type text NOT NULL DEFAULT 'fixed_total_period',
  ADD COLUMN IF NOT EXISTS day_count_basis text NOT NULL DEFAULT 'actual_365',
  ADD COLUMN IF NOT EXISTS tax_rate_snapshot numeric(8,4),
  ADD COLUMN IF NOT EXISTS deductions_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS terms_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS terms_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS agreement_document_path text,
  ADD COLUMN IF NOT EXISTS early_settlement_allowed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS compounding_allowed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS overdue_at timestamptz;
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='public.funding_commitments'::regclass AND contype='c' AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP EXECUTE format('ALTER TABLE public.funding_commitments DROP CONSTRAINT %I', c.conname); END LOOP;
END $$;
ALTER TABLE public.funding_commitments ADD CONSTRAINT funding_commitments_status_check CHECK (status IN (
'draft','interested','commitment_submitted','pending_agreement','agreement_pending','committed','payment_pending','payment_received','payment_verified','funds_pending','funded','active_funding','matured','partially_settled','settled','fully_settled','cancelled','rejected','refunded','overdue'));
CREATE UNIQUE INDEX IF NOT EXISTS funding_commitments_idempotency_unique ON public.funding_commitments(idempotency_key) WHERE idempotency_key IS NOT NULL;
ALTER TABLE public.funding_receipts
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS source_event_id text,
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversal_reference text;
CREATE UNIQUE INDEX IF NOT EXISTS funding_receipts_idempotency_unique ON public.funding_receipts(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS funding_receipts_external_reference_unique ON public.funding_receipts(external_reference) WHERE external_reference IS NOT NULL AND length(btrim(external_reference)) > 0;
ALTER TABLE public.funding_settlements
  ADD COLUMN IF NOT EXISTS requested_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS second_approved_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS second_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS failure_reason text,
  ADD COLUMN IF NOT EXISTS outstanding_after numeric(14,2);
CREATE TABLE IF NOT EXISTS public.funding_documents (
 id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
 funder_id bigint NOT NULL REFERENCES public.funding_parties(id),
 document_type text NOT NULL, object_path text NOT NULL UNIQUE, original_filename text NOT NULL,
 mime_type text NOT NULL, file_size_bytes bigint NOT NULL CHECK(file_size_bytes > 0),
 expiry_date date, review_status text NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','accepted','rejected','expired')),
 reviewed_by uuid REFERENCES auth.users(id), reviewed_at timestamptz, review_reason text,
 uploaded_by uuid REFERENCES auth.users(id), uploaded_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.funding_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.funding_documents FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.funding_documents FROM PUBLIC, anon, authenticated;
CREATE POLICY deny_browser_access ON public.funding_documents FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE TABLE IF NOT EXISTS public.funding_agreements (
 id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, commitment_id bigint NOT NULL REFERENCES public.funding_commitments(id),
 version integer NOT NULL DEFAULT 1, terms_snapshot jsonb NOT NULL, document_path text NOT NULL, document_sha256 text,
 signed_by_name text, signed_by_identity text, signed_at timestamptz, verified_by uuid REFERENCES auth.users(id),
 verified_at timestamptz, created_by uuid REFERENCES auth.users(id), created_at timestamptz NOT NULL DEFAULT now(),
 is_immutable boolean NOT NULL DEFAULT true, UNIQUE(commitment_id,version)
);
ALTER TABLE public.funding_agreements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.funding_agreements FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.funding_agreements FROM PUBLIC, anon, authenticated;
CREATE POLICY deny_browser_access ON public.funding_agreements FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE OR REPLACE FUNCTION public.prevent_funding_agreement_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN IF OLD.is_immutable THEN RAISE EXCEPTION 'Signed funding agreement versions are immutable; create a new version.'; END IF;
RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END $$;
REVOKE ALL ON FUNCTION public.prevent_funding_agreement_mutation() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS funding_agreement_immutable_guard ON public.funding_agreements;
CREATE TRIGGER funding_agreement_immutable_guard BEFORE UPDATE OR DELETE ON public.funding_agreements FOR EACH ROW EXECUTE FUNCTION public.prevent_funding_agreement_mutation();
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES ('funding-private','funding-private',false,10485760,ARRAY['application/pdf','image/jpeg','image/png'])
ON CONFLICT (id) DO UPDATE SET public=false,file_size_limit=10485760,allowed_mime_types=EXCLUDED.allowed_mime_types;
