
-- ============================================================
-- STARLINK ULTRANET
-- Migration 009: STARLINK ID Login
-- ============================================================

-- 1. Add STARLINK ID to existing user profiles.
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS starlink_id TEXT;

-- 2. Ensure every assigned STARLINK ID is unique.
-- The comparison is case-insensitive.
CREATE UNIQUE INDEX IF NOT EXISTS profiles_starlink_id_unique
ON public.profiles (UPPER(starlink_id))
WHERE starlink_id IS NOT NULL
  AND TRIM(starlink_id) <> '';

-- 3. Document the purpose of the column.
COMMENT ON COLUMN public.profiles.starlink_id IS
'Unique STARLINK login identifier assigned to a user.';

-- ============================================================
-- END OF MIGRATION 009
-- ============================================================
