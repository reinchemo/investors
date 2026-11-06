-- ============================================================
-- STARLINK ULTRANET — PHASE 0 FOUNDATION
-- Additive only. Safe to run multiple times.
-- Sections: 7, 8, 9, 10, 11, 12, 22, 23
-- ============================================================


-- ------------------------------------------------------------
-- 1. NEW COLUMNS ON transactions  (Sections 11, 12, 22)
-- ------------------------------------------------------------

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS actual_date      date,
  ADD COLUMN IF NOT EXISTS actual_time      time,
  ADD COLUMN IF NOT EXISTS fee              numeric(14,2) DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS net_amount       numeric(14,2),
  ADD COLUMN IF NOT EXISTS source           text DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS idempotency_key  text,
  ADD COLUMN IF NOT EXISTS reversal_of      text,
  ADD COLUMN IF NOT EXISTS reversed_at      timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_by      text,
  ADD COLUMN IF NOT EXISTS reversal_reason  text;

UPDATE transactions
SET actual_date = date
WHERE actual_date IS NULL;

UPDATE transactions
SET net_amount = COALESCE(amount, 0) - COALESCE(fee, 0)
WHERE net_amount IS NULL;


-- ------------------------------------------------------------
-- 2. IDEMPOTENCY KEY — unique when present  (Section 10)
-- ------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS ux_transactions_idempotency_key
  ON transactions (idempotency_key)
  WHERE idempotency_key IS NOT NULL;


-- ------------------------------------------------------------
-- 3. AUDIT LOG — append-only, DB-enforced  (Section 7)
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_log (
  id              bigserial PRIMARY KEY,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  actor           text,
  action          text NOT NULL,
  module          text NOT NULL,
  entity_id       text,
  record_before   jsonb,
  record_after    jsonb,
  changed_fields  text[],
  reason          text,
  ip_address      text,
  device_info     text
);

CREATE INDEX IF NOT EXISTS ix_audit_log_module_time
  ON audit_log (module, occurred_at DESC);

CREATE INDEX IF NOT EXISTS ix_audit_log_entity
  ON audit_log (entity_id);

CREATE OR REPLACE FUNCTION audit_log_is_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only — records cannot be modified or deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_log_no_update ON audit_log;
CREATE TRIGGER trg_audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

DROP TRIGGER IF EXISTS trg_audit_log_no_delete ON audit_log;
CREATE TRIGGER trg_audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();


-- ------------------------------------------------------------
-- 4. GENERIC AUDIT TRIGGER  (Section 7)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION write_audit_entry()
RETURNS trigger AS $$
DECLARE
  v_action    text;
  v_before    jsonb;
  v_after     jsonb;
  v_entity_id text;
  v_changed   text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action := 'INSERT';
    v_before := NULL;
    v_after  := to_jsonb(NEW);
    v_entity_id := COALESCE(NEW.id::text, NULL);
  ELSIF TG_OP = 'UPDATE' THEN
    v_action := 'UPDATE';
    v_before := to_jsonb(OLD);
    v_after  := to_jsonb(NEW);
    v_entity_id := COALESCE(NEW.id::text, NULL);

    SELECT array_agg(key)
    INTO v_changed
    FROM jsonb_each(v_after) a
    WHERE a.value IS DISTINCT FROM (v_before -> a.key);
  ELSE
    v_action := 'DELETE';
    v_before := to_jsonb(OLD);
    v_after  := NULL;
    v_entity_id := COALESCE(OLD.id::text, NULL);
  END IF;

  INSERT INTO audit_log (
    actor, action, module, entity_id,
    record_before, record_after, changed_fields
  ) VALUES (
    COALESCE(current_setting('request.jwt.claim.sub', true), 'system'),
    v_action,
    TG_TABLE_NAME,
    v_entity_id,
    v_before,
    v_after,
    v_changed
  );

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'transactions','investors','investments','dividends','proposals',
    'share_transactions','locations','staff','employees',
    'payroll_runs','payroll_items','assets','asset_movements'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit_%I ON %I', t, t);
    EXECUTE format(
      'CREATE TRIGGER trg_audit_%I
         AFTER INSERT OR UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION write_audit_entry()',
      t, t
    );
  END LOOP;
END $$;


-- ------------------------------------------------------------
-- 5. NET AMOUNT AUTO-CALC TRIGGER  (Section 22)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_net_amount()
RETURNS trigger AS $$
BEGIN
  NEW.net_amount := COALESCE(NEW.amount, 0) - COALESCE(NEW.fee, 0);
  IF NEW.actual_date IS NULL THEN
    NEW.actual_date := NEW.date;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_net_amount ON transactions;
CREATE TRIGGER trg_set_net_amount
  BEFORE INSERT OR UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION set_net_amount();


-- ------------------------------------------------------------
-- 6. DUPLICATE DETECTION FUNCTION  (Section 9)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION detect_duplicate_transaction(
  p_reference    text,
  p_amount       numeric,
  p_actual_date  date,
  p_type         text,
  p_exclude_id   text DEFAULT NULL
)
RETURNS TABLE (
  existing_id          text,
  existing_reference   text,
  existing_amount      numeric,
  existing_date        date,
  existing_type        text
) AS $$
BEGIN
  IF p_reference IS NULL OR trim(p_reference) = '' THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT t.id,
         t.reference,
         t.amount,
         COALESCE(t.actual_date, t.date),
         t.type
  FROM transactions t
  WHERE t.deleted_at IS NULL
    AND t.reversed_at IS NULL
    AND upper(trim(t.reference)) = upper(trim(p_reference))
    AND (p_exclude_id IS NULL OR t.id <> p_exclude_id);
END;
$$ LANGUAGE plpgsql STABLE;


-- ------------------------------------------------------------
-- 7. CENTRAL TRANSACTION POSTER  (Section 11)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION post_transaction(
  p_id              text,
  p_date            date,
  p_actual_date     date,
  p_actual_time     time,
  p_type            text,
  p_category        text,
  p_description     text,
  p_amount          numeric,
  p_fee             numeric,
  p_method          text,
  p_reference       text,
  p_location        text,
  p_location_id     bigint,
  p_staff_id        bigint,
  p_payroll_run_id  bigint,
  p_notes           text,
  p_source          text,
  p_idempotency_key text,
  p_created_by      text
)
RETURNS text AS $$
DECLARE
  v_existing_id text;
  v_dup_count   int;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing_id
    FROM transactions
    WHERE idempotency_key = p_idempotency_key
    LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      RETURN v_existing_id;
    END IF;
  END IF;

  SELECT COUNT(*) INTO v_dup_count
  FROM detect_duplicate_transaction(
    p_reference, p_amount, p_actual_date, p_type, NULL
  );

  IF v_dup_count > 0 THEN
    RAISE EXCEPTION 'Duplicate transaction detected for reference %', p_reference
      USING ERRCODE = '23505';
  END IF;

  INSERT INTO transactions (
    id, date, actual_date, actual_time,
    type, category, description, amount, fee,
    method, reference, location, location_id, staff_id, payroll_run_id,
    status, notes, source, idempotency_key, created_by, created_at
  ) VALUES (
    p_id, p_date, COALESCE(p_actual_date, p_date), p_actual_time,
    p_type, p_category, p_description, p_amount, COALESCE(p_fee, 0),
    p_method, p_reference, p_location, p_location_id, p_staff_id, p_payroll_run_id,
    'draft', p_notes, COALESCE(p_source, 'manual'), p_idempotency_key,
    p_created_by, now()
  );

  RETURN p_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ------------------------------------------------------------
-- 8. ARCHIVE / RESTORE HELPERS  (Section 8)
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION archive_record(
  p_table   text,
  p_id      text,
  p_actor   text,
  p_reason  text
)
RETURNS void AS $$
BEGIN
  EXECUTE format(
    'UPDATE %I SET deleted_at = now(), deleted_by = $1, delete_reason = $2 WHERE id::text = $3',
    p_table
  ) USING p_actor, p_reason, p_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION restore_record(
  p_table   text,
  p_id      text,
  p_actor   text
)
RETURNS void AS $$
BEGIN
  EXECUTE format(
    'UPDATE %I SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL WHERE id::text = $1',
    p_table
  ) USING p_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;