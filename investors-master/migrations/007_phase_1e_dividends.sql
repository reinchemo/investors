-- ============================================================
-- PHASE 1e — Dividends Workflow
-- Adds reconciliation columns + mark_dividend_paid() function.
-- Sections: 16 (Dividends), 11 (Central transaction engine)
-- ============================================================

-- 1. Add missing columns
ALTER TABLE dividends
  ADD COLUMN IF NOT EXISTS reviewed_at     timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_by     text,
  ADD COLUMN IF NOT EXISTS reconciled_at   timestamptz,
  ADD COLUMN IF NOT EXISTS reconciled_by   text,
  ADD COLUMN IF NOT EXISTS linked_txn_ids  text[];

-- 2. Ensure the Dividend Payment category exists
INSERT INTO categories (code, name, kind, is_system)
VALUES ('dividend_payment', 'Dividend Payment', 'expense', true)
ON CONFLICT DO NOTHING;

-- 3. mark_dividend_paid() — atomic payout + transaction creation
CREATE OR REPLACE FUNCTION mark_dividend_paid(
  p_dividend_id text,
  p_actor       text
)
RETURNS jsonb AS $$
DECLARE
  v_div          record;
  v_alloc        jsonb;
  v_alloc_count  int := 0;
  v_txn_ids      text[] := ARRAY[]::text[];
  v_txn_id       text;
  v_investor_ref text;
  v_amount       numeric;
  v_name         text;
  v_pay_date     date;
BEGIN
  SELECT id, period_label, status, total_distributable, allocations,
         COALESCE(paid_at, now())::date AS paid_date
  INTO v_div
  FROM dividends
  WHERE id = p_dividend_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dividend % not found', p_dividend_id;
  END IF;

  IF v_div.status NOT IN ('approved', 'paid') THEN
    RAISE EXCEPTION 'Dividend must be approved before it can be paid (current status: %)', v_div.status;
  END IF;

  IF (SELECT linked_txn_ids FROM dividends WHERE id = p_dividend_id) IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status', 'already_paid',
      'message', 'This dividend already has linked transactions'
    );
  END IF;

  v_pay_date := v_div.paid_date;

  IF v_div.allocations IS NULL OR jsonb_array_length(v_div.allocations) = 0 THEN
    RAISE EXCEPTION 'Dividend has no allocations';
  END IF;

  FOR v_alloc IN SELECT * FROM jsonb_array_elements(v_div.allocations)
  LOOP
    v_amount := COALESCE((v_alloc->>'amount')::numeric, 0);
    v_name   := COALESCE(v_alloc->>'name', 'Unknown');

    IF v_amount <= 0 THEN
      CONTINUE;
    END IF;

    v_investor_ref := COALESCE(v_alloc->>'InvestorId', '');

    v_txn_id := 'TXN-DIV-' || p_dividend_id || '-' || COALESCE(v_investor_ref, 'x');

    INSERT INTO transactions (
      id, date, actual_date, type, category, description,
      amount, fee, method, reference, status, source,
      idempotency_key, notes, created_by, created_at
    ) VALUES (
      v_txn_id,
      v_pay_date,
      v_pay_date,
      'expense',
      'Dividend Payment',
      'Dividend ' || v_div.period_label || ' — ' || v_name,
      v_amount,
      0,
      'bank',
      'DIV-' || p_dividend_id || '-' || COALESCE(v_investor_ref, 'x'),
      'posted',
      'dividend',
      'dividend-' || p_dividend_id || '-' || COALESCE(v_investor_ref, 'x'),
      'Auto-created when dividend marked paid.',
      p_actor,
      now()
    )
    ON CONFLICT (id) DO NOTHING;

    v_txn_ids := array_append(v_txn_ids, v_txn_id);
    v_alloc_count := v_alloc_count + 1;
  END LOOP;

  UPDATE dividends
  SET status         = 'paid',
      paid_at        = COALESCE(paid_at, now()),
      linked_txn_ids = v_txn_ids,
      updated_at     = now(),
      updated_by     = p_actor
  WHERE id = p_dividend_id;

  RETURN jsonb_build_object(
    'status',               'paid',
    'dividend_id',          p_dividend_id,
    'transactions_created', v_alloc_count,
    'txn_ids',              v_txn_ids
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;