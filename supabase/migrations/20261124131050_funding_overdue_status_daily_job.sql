CREATE OR REPLACE FUNCTION public.mark_overdue_funding_commitments()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE changed_count integer := 0;
BEGIN
  WITH totals AS (
    SELECT c.id,
      COALESCE(sum(l.amount) FILTER (WHERE l.entry_type='principal_received'),0)-COALESCE(sum(l.amount) FILTER (WHERE l.entry_type='principal_repaid'),0) AS principal_due,
      COALESCE(sum(l.amount) FILTER (WHERE l.entry_type='return_paid'),0) AS return_paid
    FROM public.funding_commitments c LEFT JOIN public.funding_liability_ledger l ON l.commitment_id=c.id
    GROUP BY c.id
  ), expected AS (
    SELECT c.id,t.principal_due,t.return_paid,
      CASE WHEN COALESCE(c.terms_snapshot->>'return_type',c.return_type)='annualised_simple'
        THEN c.principal_amount*COALESCE((c.terms_snapshot->>'return_rate')::numeric,c.agreed_return_rate)/100*
          COALESCE((c.terms_snapshot->>'term_days')::numeric,c.term_days)/
          CASE WHEN COALESCE(c.terms_snapshot->>'day_count_basis',c.day_count_basis) IN ('actual_360','30_360') THEN 360 ELSE 365 END
        ELSE c.principal_amount*COALESCE((c.terms_snapshot->>'return_rate')::numeric,c.agreed_return_rate)/100 END AS gross_return,
      COALESCE((c.terms_snapshot->>'tax_rate')::numeric,c.tax_rate_snapshot,0) AS tax_rate,
      COALESCE(c.terms_snapshot->'other_deductions',c.deductions_snapshot,'[]'::jsonb) AS other_deductions
    FROM public.funding_commitments c JOIN totals t ON t.id=c.id
    WHERE c.status IN ('matured','active_funding','funded','partially_settled') AND c.maturity_date<current_date
  ), due AS (
    SELECT e.*,
      greatest(0,e.gross_return-e.gross_return*e.tax_rate/100-
        COALESCE((SELECT sum(CASE WHEN item->>'type'='fixed' THEN COALESCE((item->>'amount')::numeric,0)
          ELSE e.gross_return*COALESCE((item->>'rate')::numeric,(item->>'percentage')::numeric,0)/100 END)
          FROM jsonb_array_elements(e.other_deductions) item),0))-e.return_paid AS return_due
    FROM expected e
  )
  UPDATE public.funding_commitments c SET status='overdue',updated_at=now()
  FROM due d WHERE d.id=c.id AND (d.principal_due>0.01 OR d.return_due>0.01);
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  RETURN changed_count;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_overdue_funding_commitments() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_overdue_funding_commitments() TO postgres, service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname='funding-mark-overdue-daily') THEN
    PERFORM cron.unschedule('funding-mark-overdue-daily');
  END IF;
END $$;

SELECT cron.schedule('funding-mark-overdue-daily','59 2 * * *',$$SELECT public.mark_overdue_funding_commitments();$$);
