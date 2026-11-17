
BEGIN;

-- Remove the one-role-per-user restriction.
ALTER TABLE public.user_roles
DROP CONSTRAINT IF EXISTS user_roles_user_id_key;

-- Allow multiple roles per user, but prevent duplicate
-- assignments of the same role to the same user.
CREATE UNIQUE INDEX IF NOT EXISTS user_roles_user_id_role_id_unique
ON public.user_roles (user_id, role_id)
WHERE user_id IS NOT NULL
  AND role_id IS NOT NULL;

COMMIT;
