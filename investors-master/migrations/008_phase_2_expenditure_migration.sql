-- ============================================================
-- PHASE 2 — Retire the Expenditure App
-- Migrates expenditure_data blob into transactions table.
-- Sections: 3.2 (One Source of Truth), 11 (Transaction Engine)
-- ============================================================

-- 1. Backup the blob before touching anything
CREATE TABLE IF NOT EXISTS _backup_expenditure_data_phase2 AS
SELECT * FROM expenditure_data;

-- 2. Ensure destination categories exist
INSERT INTO categories (code, name, kind, is_system) VALUES
  ('starlink_general',        'Starlink General',       'expense', true),
  ('common_investment',       'Common Investment',      'capital', true),
  ('common_expenditure',      'Common Expenditure',     'expense', true),
  ('tokens',                  'Tokens',                 'expense', true),
  ('fuel_bike',               'Fuel/Bike',              'expense', true),
  ('routers',                 'Routers',                'expense', true),
  ('kairo_routers',           'Kairo Routers',          'expense', true),
  ('darkwebs_expenditure',    'Darkwebs Expenditure',   'expense', true)
ON CONFLICT DO NOTHING;

-- 3. Migrate 195 rows from blob → transactions
--    Idempotent: ON CONFLICT (id) DO NOTHING means re-running creates nothing.
INSERT INTO transactions (
  id, date, actual_date, actual_time, type, category, description,
  amount, fee, method, reference, status, source,
  idempotency_key, notes, created_by, created_at
)
WITH blob AS (
  SELECT data AS d FROM expenditure_data WHERE id = 1
),
groups AS (
  SELECT
    (g->>'id')::bigint  AS group_id,
    (g->>'date')::date  AS group_date,
    g->'rows'           AS group_rows
  FROM blob, jsonb_array_elements(d->'data') g
),
rows_expanded AS (
  SELECT
    g.group_id, g.group_date,
    (r->>'id')::bigint AS row_id,
    r AS row_json
  FROM groups g, jsonb_array_elements(g.group_rows) r
),
column_map AS (
  SELECT * FROM (VALUES
    ('starlinkGeneral',              'Starlink General',      'expense'),
    ('commonInvestment',             'Common Investment',     'capital'),
    ('commonExpenditure',            'Common Expenditure',    'expense'),
    ('tokens',                       'Tokens',                'expense'),
    ('fuelBike',                     'Fuel/Bike',             'expense'),
    ('routers',                      'Routers',               'expense'),
    ('saved_6_kairo_routers',        'Kairo Routers',         'expense'),
    ('saved_2_darkwebs_expenditure', 'Darkwebs Expenditure',  'expense')
  ) AS t(col_key, category_name, txn_type)
)
SELECT
  'TXN-EXP-' || re.group_id || '-' || re.row_id || '-' || cm.col_key  AS id,
  re.group_date                                                        AS date,
  re.group_date                                                        AS actual_date,
  NULL                                                                 AS actual_time,
  cm.txn_type                                                          AS type,
  cm.category_name                                                     AS category,
  COALESCE(NULLIF(re.row_json->>(cm.col_key || '_desc'), ''), 
           cm.category_name)                                           AS description,
  (re.row_json->>(cm.col_key || '_amount'))::numeric                   AS amount,
  0                                                                    AS fee,
  'other'                                                              AS method,
  COALESCE(NULLIF(re.row_json->>(cm.col_key || '_transaction'), ''), 
           'MIGRATION')                                                AS reference,
  'posted'                                                             AS status,
  'migration'                                                          AS source,
  'expenditure-migration:' || re.group_id || ':' || re.row_id || ':' || cm.col_key
                                                                       AS idempotency_key,
  'Migrated from expenditure_data blob. Original grid: date group ' 
    || re.group_id || ', row ' || re.row_id                            AS notes,
  'admin'                                                              AS created_by,
  now()                                                                AS created_at
FROM rows_expanded re
CROSS JOIN column_map cm
WHERE
  (re.row_json->>(cm.col_key || '_amount')) ~ '^-?[0-9.]+$'
  AND (re.row_json->>(cm.col_key || '_amount'))::numeric <> 0
ON CONFLICT (id) DO NOTHING;

-- 4. Verify
-- Expected: 195 rows, total 550948.00
SELECT 
  COUNT(*) AS migrated_rows,
  ROUND(SUM(amount), 2) AS total_amount
FROM transactions
WHERE source = 'migration' 
  AND id LIKE 'TXN-EXP-%';