-- ============================================================
-- PHASE 1a — Migrate STARLINK LLC VIRTUAL base into transactions
-- Date: 2026-09-29 (day the ledger system went live)
-- Amount: 377,259 (275,193 base + 102,066 capital addition)
-- Category: STARLINK Virtual Capital
-- ============================================================

INSERT INTO transactions (
  id, date, actual_date, actual_time, type, category, description,
  amount, fee, net_amount, method, reference, location,
  status, source, idempotency_key, notes, created_by, created_at
)
SELECT
  'TXN-MIGRATION-STARLINK-VIRTUAL-BASE-001',
  '2026-09-29',
  '2026-09-29',
  NULL,
  'expense',
  'STARLINK Virtual Capital',
  'STARLINK LLC VIRTUAL opening equity base (275,193 + 102,066) — migrated from hardcoded constant',
  377259,
  0,
  377259,
  'other',
  'MIGRATION-2026-09-29-VIRTUAL-BASE',
  NULL,
  'posted',
  'migration',
  'starlink-investment-migration-001',
  'Historical STARLINK LLC VIRTUAL base. Migrated 2026-10-08 from hardcoded STARLINK_VIRTUAL_BASE constant. Preserves existing equity so ownership % remain unchanged.',
  'admin',
  now()
WHERE NOT EXISTS (
  SELECT 1 FROM transactions WHERE idempotency_key = 'starlink-investment-migration-001'
);