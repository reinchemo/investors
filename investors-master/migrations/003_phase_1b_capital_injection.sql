-- ============================================================
-- PHASE 1b — record_capital_injection()
-- Atomic capital injection: investments + share_transactions + investors.equity
-- Sections: 13.1 (Capital Injection), 15 (Equity History)
-- ============================================================

CREATE OR REPLACE FUNCTION record_capital_injection(
  p_investor_id     bigint,
  p_amount          numeric,
  p_date            date,
  p_type            text,
  p_reference       text,
  p_notes           text,
  p_reason          text,
  p_actor           text,
  p_idempotency_key text
)
RETURNS jsonb AS $$
DECLARE
  v_investor          record;
  v_old_equity        numeric;
  v_new_equity        numeric;
  v_delta             numeric;
  v_total_before      numeric;
  v_total_after       numeric;
  v_pct_before        numeric;
  v_pct_after         numeric;
  v_investment_id     bigint;
  v_share_txn_id      bigint;
  v_action            text;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_investment_id
    FROM investments
    WHERE reference = p_idempotency_key
    LIMIT 1;

    IF v_investment_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'status', 'already_recorded',
        'investment_id', v_investment_id,
        'message', 'This injection was already recorded'
      );
    END IF;
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be greater than 0';
  END IF;

  IF p_type NOT IN ('initial', 'additional', 'withdrawal') THEN
    RAISE EXCEPTION 'Type must be initial, additional, or withdrawal';
  END IF;

  SELECT id, equity, deleted_at
  INTO v_investor
  FROM investors
  WHERE id = p_investor_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Investor % not found', p_investor_id;
  END IF;

  IF v_investor.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot inject capital into an archived investor';
  END IF;

  v_old_equity := COALESCE(v_investor.equity, 0);

  IF p_type = 'withdrawal' THEN
    v_new_equity := v_old_equity - p_amount;
    IF v_new_equity < 0 THEN
      RAISE EXCEPTION 'Withdrawal would reduce equity below 0';
    END IF;
    v_delta := -p_amount;
    v_action := 'buyback';
  ELSE
    v_new_equity := v_old_equity + p_amount;
    v_delta := p_amount;
    v_action := CASE p_type WHEN 'initial' THEN 'initial' ELSE 'additional' END;
  END IF;

  SELECT COALESCE(SUM(equity), 0) INTO v_total_before
  FROM investors
  WHERE deleted_at IS NULL;

  v_total_after := v_total_before + v_delta;

  v_pct_before := CASE WHEN v_total_before > 0
                       THEN ROUND((v_old_equity / v_total_before) * 100, 4)
                       ELSE 0 END;
  v_pct_after  := CASE WHEN v_total_after  > 0
                       THEN ROUND((v_new_equity / v_total_after) * 100, 4)
                       ELSE 0 END;

  INSERT INTO investments (
    investor_id, date, amount, type, reference, notes,
    created_at, created_by
  ) VALUES (
    p_investor_id, p_date, p_amount, p_type,
    COALESCE(p_reference, p_idempotency_key),
    p_notes, now(), p_actor
  )
  RETURNING id INTO v_investment_id;

  INSERT INTO share_transactions (
    investor_id, date, action,
    equity_before, equity_after, delta,
    pct_before, pct_after,
    reference, notes, reason,
    created_at, created_by
  ) VALUES (
    p_investor_id, p_date, v_action,
    v_old_equity, v_new_equity, v_delta,
    v_pct_before, v_pct_after,
    COALESCE(p_reference, p_idempotency_key),
    p_notes, p_reason,
    now(), p_actor
  )
  RETURNING id INTO v_share_txn_id;

  UPDATE investors
  SET equity = v_new_equity,
      updated_at = now()
  WHERE id = p_investor_id;

  RETURN jsonb_build_object(
    'status',          'created',
    'investment_id',   v_investment_id,
    'share_txn_id',    v_share_txn_id,
    'investor_id',     p_investor_id,
    'equity_before',   v_old_equity,
    'equity_after',    v_new_equity,
    'delta',           v_delta,
    'pct_before',      v_pct_before,
    'pct_after',       v_pct_after,
    'total_before',    v_total_before,
    'total_after',     v_total_after
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;