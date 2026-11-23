-- Funding module permissions. Existing roles are least-privilege by default.
INSERT INTO public.role_permissions(role_id,module,can_view,can_create,can_edit,can_delete,can_approve,can_export)
SELECT r.id,'Funding',
 CASE r.name WHEN 'Full Administrator' THEN true WHEN 'Finance Manager' THEN true WHEN 'Accountant' THEN true ELSE false END,
 CASE r.name WHEN 'Full Administrator' THEN true WHEN 'Finance Manager' THEN true ELSE false END,
 CASE r.name WHEN 'Full Administrator' THEN true WHEN 'Finance Manager' THEN true ELSE false END,
 CASE r.name WHEN 'Full Administrator' THEN true ELSE false END,
 CASE r.name WHEN 'Full Administrator' THEN true WHEN 'Finance Manager' THEN true ELSE false END,
 CASE r.name WHEN 'Full Administrator' THEN true WHEN 'Finance Manager' THEN true WHEN 'Accountant' THEN true ELSE false END
FROM public.roles r
ON CONFLICT (role_id,module) DO NOTHING;