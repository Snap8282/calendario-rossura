-- Run AFTER 202610100001_security_hardening.sql on an existing project.
-- Keeps the member selector's response unchanged, without owner-backed view access.
-- No bookings, members or passwords are deleted/reset. Safe to run again.
begin;

-- An invoker view cannot inspect pin_hash without granting hash access to callers.
-- Expose only a computed boolean instead; Postgres maintains it on password changes.
alter table public.members
  add column if not exists has_pin boolean
  generated always as (pin_hash is not null) stored;

-- Refuse to trust a pre-existing column with a different definition.
do $$
begin
  if not exists (
    select 1 from pg_attribute a
    join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = 'public.members'::regclass and a.attname = 'has_pin'
      and not a.attisdropped and a.attgenerated = 's'
      and a.atttypid = 'boolean'::regtype
      and pg_get_expr(d.adbin, d.adrelid) = '(pin_hash IS NOT NULL)'
  ) then
    raise exception 'members.has_pin must be generated from pin_hash IS NOT NULL';
  end if;
end $$;

create or replace view public.members_public with (security_invoker = true) as
  select id, name, is_admin, has_pin from public.members;

alter table public.members enable row level security;
drop policy if exists "members readable by everyone" on public.members;
drop policy if exists "members safe fields readable" on public.members;
create policy "members safe fields readable"
  on public.members for select to anon, authenticated using (true);

-- Clear both table-level and legacy column-level privileges before the allowlist.
revoke all on public.members, public.members_public from public, anon, authenticated;
do $$
declare c record;
begin
  for c in
    select attname from pg_attribute
    where attrelid = 'public.members'::regclass and attnum > 0 and not attisdropped
  loop
    execute format('revoke select (%1$I), insert (%1$I), update (%1$I), references (%1$I) on public.members from public, anon, authenticated', c.attname);
  end loop;
end $$;
grant usage on schema public to anon, authenticated;
grant select (id, name, is_admin, has_pin) on public.members to anon, authenticated;
grant select on public.members_public to anon, authenticated;

notify pgrst, 'reload schema';
commit;
