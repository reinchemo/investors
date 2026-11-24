CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
GRANT USAGE ON SCHEMA cron TO postgres;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA cron TO postgres;

CREATE OR REPLACE FUNCTION public.enqueue_funding_maturity_notifications()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE inserted_count integer := 0;
BEGIN
  WITH balances AS (
    SELECT c.id,c.funder_id,c.maturity_date,c.currency_code,c.principal_amount,c.status,
      COALESCE(sum(l.amount) FILTER (WHERE l.entry_type='principal_received'),0)-COALESCE(sum(l.amount) FILTER (WHERE l.entry_type='principal_repaid'),0) AS principal_due,
      c.terms_snapshot,c.agreed_return_rate,c.term_days,c.return_type,c.day_count_basis,c.tax_rate_snapshot,c.deductions_snapshot,
      COALESCE(sum(l.amount) FILTER (WHERE l.entry_type='return_paid'),0) AS return_paid
    FROM public.funding_commitments c LEFT JOIN public.funding_liability_ledger l ON l.commitment_id=c.id
    WHERE c.status IN ('active_funding','funded','matured','partially_settled','overdue') AND c.maturity_date IS NOT NULL
    GROUP BY c.id
  ), calculated AS (
    SELECT b.*,
      CASE WHEN COALESCE(b.terms_snapshot->>'return_type',b.return_type)='annualised_simple'
        THEN b.principal_amount*COALESCE((b.terms_snapshot->>'return_rate')::numeric,b.agreed_return_rate)/100*
          COALESCE((b.terms_snapshot->>'term_days')::numeric,b.term_days)/
          CASE WHEN COALESCE(b.terms_snapshot->>'day_count_basis',b.day_count_basis) IN ('actual_360','30_360') THEN 360 ELSE 365 END
        ELSE b.principal_amount*COALESCE((b.terms_snapshot->>'return_rate')::numeric,b.agreed_return_rate)/100 END AS gross_return
    FROM balances b
  ), due AS (
    SELECT c.*,greatest(0,c.gross_return-c.gross_return*COALESCE((c.terms_snapshot->>'tax_rate')::numeric,c.tax_rate_snapshot,0)/100-
      COALESCE((SELECT sum(CASE WHEN item->>'type'='fixed' THEN COALESCE((item->>'amount')::numeric,0)
        ELSE c.gross_return*COALESCE((item->>'rate')::numeric,(item->>'percentage')::numeric,0)/100 END)
        FROM jsonb_array_elements(COALESCE(c.terms_snapshot->'other_deductions',c.deductions_snapshot,'[]'::jsonb)) item),0))-c.return_paid AS return_due
    FROM calculated c
  ), reminders AS (
    SELECT d.*,(d.maturity_date-current_date) AS days_left,
      CASE WHEN d.maturity_date-current_date IN (30,14,7,3,0) THEN d.maturity_date-current_date ELSE NULL END AS reminder_day
    FROM due d
  ), recipients AS (
    SELECT r.*,pa.user_id AS recipient_user_id,fp.legal_name
    FROM reminders r JOIN public.funding_parties fp ON fp.id=r.funder_id
    JOIN public.personal_portal_accounts pa ON pa.account_status='active'
      AND (pa.funder_id=fp.id OR (fp.investor_id IS NOT NULL AND pa.investor_id=fp.investor_id))
    WHERE r.reminder_day IS NOT NULL OR (r.days_left<0 AND (r.principal_due>0.01 OR r.return_due>0.01))
  ), inserted AS (
    INSERT INTO public.notifications(kind,severity,title,body,link_view,link_ref,dedupe_key,created_by,metadata,recipient_user_id)
    SELECT 'funding_maturity',
      CASE WHEN days_left<=0 THEN 'warning' WHEN days_left<=7 THEN 'warning' ELSE 'info' END,
      CASE WHEN days_left<0 THEN 'Matured funding remains outstanding' WHEN days_left=0 THEN 'Funding reaches maturity today' ELSE 'Funding maturity in '||days_left||' days' END,
      'Contract #'||id||' for '||legal_name||' matures on '||maturity_date||'. Outstanding principal: '||round(greatest(0,principal_due),2)||' '||currency_code||'; estimated outstanding return: '||round(greatest(0,return_due),2)||' '||currency_code||'.',
      'funding','commitment:'||id,
      CASE WHEN days_left<0 THEN 'funding-overdue:'||id||':'||current_date ELSE 'funding-maturity:'||id||':'||reminder_day END,
      'system:funding-maturity',
      jsonb_build_object('commitment_id',id,'maturity_date',maturity_date,'days_remaining',days_left,'principal_due',greatest(0,principal_due),'return_due',greatest(0,return_due)),
      recipient_user_id
    FROM recipients ON CONFLICT (dedupe_key) DO NOTHING RETURNING 1
  )
  SELECT count(*) INTO inserted_count FROM inserted;
  RETURN inserted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_funding_maturity_notifications() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_funding_maturity_notifications() TO postgres, service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname='funding-maturity-reminders-daily') THEN
    PERFORM cron.unschedule('funding-maturity-reminders-daily');
  END IF;
END $$;

SELECT cron.schedule('funding-maturity-reminders-daily','0 3 * * *',$$SELECT public.enqueue_funding_maturity_notifications();$$);
