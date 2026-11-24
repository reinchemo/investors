ALTER TABLE public.funding_commitments
  ADD COLUMN IF NOT EXISTS source_renewal_election_id bigint;

CREATE TABLE IF NOT EXISTS public.funding_renewal_elections (
  id bigserial PRIMARY KEY,
  source_commitment_id bigint NOT NULL REFERENCES public.funding_commitments(id),
  funder_id bigint NOT NULL REFERENCES public.funding_parties(id),
  election_type text NOT NULL CHECK (election_type IN ('withdraw','reinvest_principal','reinvest_principal_and_return','reinvest_partial')),
  requested_amount numeric(14,2),
  target_opportunity_id bigint REFERENCES public.funding_opportunities(id),
  status text NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review','approved','rejected','processed','cancelled')),
  decision_reason text,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  approved_by uuid REFERENCES auth.users(id),
  approved_at timestamptz,
  new_commitment_id bigint REFERENCES public.funding_commitments(id),
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT funding_renewal_elections_amount_check CHECK (requested_amount IS NULL OR requested_amount > 0),
  CONSTRAINT funding_renewal_elections_target_check CHECK (
    (election_type = 'withdraw' AND target_opportunity_id IS NULL) OR
    (election_type <> 'withdraw' AND target_opportunity_id IS NOT NULL)
  )
);

ALTER TABLE public.funding_commitments
  ADD CONSTRAINT funding_commitments_source_renewal_election_fk
  FOREIGN KEY (source_renewal_election_id) REFERENCES public.funding_renewal_elections(id);

CREATE UNIQUE INDEX IF NOT EXISTS funding_renewal_one_open_election_per_commitment
  ON public.funding_renewal_elections(source_commitment_id)
  WHERE status IN ('pending_review','approved');

CREATE UNIQUE INDEX IF NOT EXISTS funding_commitments_one_renewal_child
  ON public.funding_commitments(source_renewal_election_id)
  WHERE source_renewal_election_id IS NOT NULL;

ALTER TABLE public.funding_renewal_elections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_browser_access ON public.funding_renewal_elections;
CREATE POLICY deny_browser_access ON public.funding_renewal_elections
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
REVOKE ALL ON public.funding_renewal_elections FROM anon, authenticated;
GRANT ALL ON public.funding_renewal_elections TO service_role;

CREATE OR REPLACE FUNCTION public.complete_funding_reinvestment(
  p_election_id bigint,
  p_new_commitment_id bigint,
  p_actor uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  e public.funding_renewal_elections%ROWTYPE;
  src public.funding_commitments%ROWTYPE;
  dst public.funding_commitments%ROWTYPE;
  received_principal numeric(14,2) := 0;
  principal_repaid numeric(14,2) := 0;
  return_paid numeric(14,2) := 0;
  outstanding_principal numeric(14,2) := 0;
  gross_return numeric(14,2) := 0;
  net_return numeric(14,2) := 0;
  outstanding_return numeric(14,2) := 0;
  rollover_amount numeric(14,2) := 0;
  source_principal_credit numeric(14,2) := 0;
  source_return_credit numeric(14,2) := 0;
  receipt_id bigint;
  settlement_id bigint;
  ref text;
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'Authorised actor is required'; END IF;
  SELECT * INTO e FROM public.funding_renewal_elections WHERE id=p_election_id FOR UPDATE;
  IF NOT FOUND OR e.status <> 'approved' THEN RAISE EXCEPTION 'Renewal election is not approved or has already been processed'; END IF;
  SELECT * INTO src FROM public.funding_commitments WHERE id=e.source_commitment_id AND funder_id=e.funder_id FOR UPDATE;
  IF NOT FOUND OR src.status NOT IN ('matured','overdue','partially_settled') THEN RAISE EXCEPTION 'Only matured or overdue funding can be renewed'; END IF;
  SELECT * INTO dst FROM public.funding_commitments WHERE id=p_new_commitment_id AND source_renewal_election_id=e.id AND funder_id=e.funder_id FOR UPDATE;
  IF NOT FOUND OR dst.status <> 'payment_pending' OR dst.signed_at IS NULL OR dst.terms_locked_at IS NULL THEN RAISE EXCEPTION 'The new funding agreement must be signed and locked first'; END IF;
  IF EXISTS (SELECT 1 FROM public.funding_liability_ledger WHERE commitment_id=dst.id) THEN RAISE EXCEPTION 'The new funding contract already has ledger activity'; END IF;

  SELECT COALESCE(sum(amount) FILTER (WHERE entry_type='principal_received'),0),
         COALESCE(sum(amount) FILTER (WHERE entry_type='principal_repaid'),0),
         COALESCE(sum(amount) FILTER (WHERE entry_type='return_paid'),0)
    INTO received_principal,principal_repaid,return_paid
    FROM public.funding_liability_ledger WHERE commitment_id=src.id;
  outstanding_principal := greatest(0,received_principal-principal_repaid);
  gross_return := CASE WHEN COALESCE(src.return_type,'fixed_total_period')='annualised_simple'
    THEN src.principal_amount*src.agreed_return_rate/100*src.term_days/CASE WHEN src.day_count_basis IN ('actual_360','30_360') THEN 360 ELSE 365 END
    ELSE src.principal_amount*src.agreed_return_rate/100 END;
  net_return := greatest(0,gross_return-gross_return*COALESCE(src.tax_rate_snapshot,0)/100-
    COALESCE((SELECT sum(CASE WHEN item->>'type'='fixed' THEN COALESCE((item->>'amount')::numeric,0)
      ELSE gross_return*COALESCE((item->>'rate')::numeric,(item->>'percentage')::numeric,0)/100 END)
      FROM jsonb_array_elements(COALESCE(src.terms_snapshot->'other_deductions',src.deductions_snapshot,'[]'::jsonb)) item),0));
  outstanding_return := greatest(0,net_return-return_paid);

  IF e.election_type='reinvest_principal' THEN rollover_amount:=outstanding_principal;
  ELSIF e.election_type='reinvest_principal_and_return' THEN rollover_amount:=outstanding_principal+outstanding_return;
  ELSIF e.election_type='reinvest_partial' THEN rollover_amount:=COALESCE(e.requested_amount,0);
  ELSE RAISE EXCEPTION 'Withdrawal elections do not create reinvestment contracts'; END IF;
  IF rollover_amount<=0 OR abs(rollover_amount-dst.principal_amount)>0.01 OR abs(rollover_amount-COALESCE(e.requested_amount,rollover_amount))>0.01 THEN RAISE EXCEPTION 'Renewal amount does not match the approved election and new contract'; END IF;
  IF rollover_amount>outstanding_principal+outstanding_return+0.01 THEN RAISE EXCEPTION 'Renewal exceeds the available maturity balance'; END IF;
  source_principal_credit:=least(rollover_amount,outstanding_principal);
  source_return_credit:=rollover_amount-source_principal_credit;
  IF source_return_credit>outstanding_return+0.01 THEN RAISE EXCEPTION 'Renewal exceeds the available return balance'; END IF;

  ref:='REINVEST-'||e.id::text;
  INSERT INTO public.funding_settlements(commitment_id,principal_paid,return_paid,paid_on,payment_reference,status,approved_by,approved_at,created_by,requested_by)
  VALUES(src.id,source_principal_credit,source_return_credit,current_date,ref,'paid',p_actor,now(),e.created_by,e.created_by)
  RETURNING id INTO settlement_id;
  INSERT INTO public.funding_liability_ledger(commitment_id,settlement_id,entry_type,amount,currency_code,effective_date,reference,created_by)
  SELECT src.id,settlement_id,'principal_repaid',source_principal_credit,src.currency_code,current_date,ref,p_actor WHERE source_principal_credit>0;
  INSERT INTO public.funding_liability_ledger(commitment_id,settlement_id,entry_type,amount,currency_code,effective_date,reference,created_by)
  SELECT src.id,settlement_id,'return_paid',source_return_credit,src.currency_code,current_date,ref,p_actor WHERE source_return_credit>0;

  INSERT INTO public.funding_receipts(commitment_id,amount,currency_code,received_on,payment_method,external_reference,verification_status,verified_by,verified_at,notes,created_by,idempotency_key,source_event_id)
  VALUES(dst.id,rollover_amount,dst.currency_code,current_date,'internal_reinvestment',ref,'verified',p_actor,now(),'Internal reinvestment from funding contract '||src.id,e.created_by,ref,ref)
  RETURNING id INTO receipt_id;
  INSERT INTO public.funding_liability_ledger(commitment_id,receipt_id,entry_type,amount,currency_code,effective_date,reference,created_by)
  VALUES(dst.id,receipt_id,'principal_received',rollover_amount,dst.currency_code,current_date,ref,p_actor);

  UPDATE public.funding_commitments SET status=CASE WHEN source_principal_credit>=outstanding_principal-0.01 AND source_return_credit>=outstanding_return-0.01 THEN 'fully_settled' ELSE 'partially_settled' END,updated_at=now() WHERE id=src.id;
  UPDATE public.funding_commitments SET status='payment_verified',updated_at=now() WHERE id=dst.id;
  UPDATE public.funding_renewal_elections SET status='processed',new_commitment_id=dst.id,processed_at=now(),updated_at=now() WHERE id=e.id;
  RETURN jsonb_build_object('success',true,'election_id',e.id,'source_commitment_id',src.id,'new_commitment_id',dst.id,'amount',rollover_amount,'receipt_id',receipt_id,'settlement_id',settlement_id);
END;
$$;

REVOKE ALL ON FUNCTION public.complete_funding_reinvestment(bigint,bigint,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_funding_reinvestment(bigint,bigint,uuid) TO service_role;
