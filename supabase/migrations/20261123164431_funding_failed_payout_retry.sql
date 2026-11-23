ALTER TABLE public.funding_settlements DROP CONSTRAINT IF EXISTS funding_settlements_status_check;
ALTER TABLE public.funding_settlements ADD CONSTRAINT funding_settlements_status_check CHECK (status IN ('draft','pending_approval','approved','paid','failed','cancelled'));
