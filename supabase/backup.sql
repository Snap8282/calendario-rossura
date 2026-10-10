-- Run once in the Supabase SQL Editor. Only privileged backend keys can call this.
begin;
create or replace function public.export_booking_backup()
returns jsonb
language sql stable security invoker
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'format_version', 1,
    'schema_version', 1,
    'snapshot_at', statement_timestamp(),
    'tables', jsonb_build_object(
      'members', (select coalesce(jsonb_agg(to_jsonb(m) order by m.id), '[]'::jsonb)
                  from public.members m),
      'bookings', (select coalesce(jsonb_agg(to_jsonb(b) - 'during' order by b.id), '[]'::jsonb)
                   from public.bookings b)
    )
  );
$$;
revoke all on function public.export_booking_backup() from public, anon, authenticated;
grant usage on schema public to service_role;
grant select on public.members, public.bookings to service_role;
grant execute on function public.export_booking_backup() to service_role;
commit;
