-- Fresh projects only. Do not run when restoring a backup of existing members.
-- Set the Admin password privately before distributing the family URL.
insert into public.members (name, is_admin) values
  ('Admin', true), ('Angela', false), ('Gaia', false), ('Marta', false),
  ('Monica', false), ('Mattia', false), ('Nora', false), ('Chiara', false),
  ('Michele', false), ('Simone', false), ('Cecilia', false), ('Paola', false), ('Milo', false)
on conflict (name) do nothing;
