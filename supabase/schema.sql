-- Family Home Booking Webapp - database schema
-- Run this once in your Supabase project's SQL editor (Project > SQL Editor > New query).
--
-- Security model: this app does NOT use Supabase Auth / real accounts. There is
-- no sensitive data here, so the goal is a "spreadsheet lock", not real security:
-- each family member picks their name and a password. All writes go through
-- the RPC functions below (SECURITY DEFINER), which check the password server-side
-- before touching the tables. The tables themselves grant no direct INSERT/
-- UPDATE/DELETE to the public "anon" role, so the password check cannot be bypassed
-- from the browser console.

-- Supabase installs extensions into the "extensions" schema, not "public".
-- The SECURITY DEFINER functions below pin their search_path for safety, so
-- "extensions" has to be listed explicitly or crypt()/gen_salt() won't resolve.
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.members (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  pin_hash text,
  is_admin boolean not null default false
);

create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members(id) on delete cascade,
  start_date date not null,
  end_date date not null check (end_date > start_date),
  note text,
  created_at timestamptz not null default now(),
  -- Half-open range [start_date, end_date): the checkout day is NOT part of
  -- the reserved range, so a new booking can start that same day.
  during daterange generated always as (daterange(start_date, end_date, '[)')) stored,
  exclude using gist (during with &&)
);

-- A view that hides pin_hash from anything the browser can query directly.
create or replace view public.members_public as
  select id, name, is_admin, (pin_hash is not null) as has_pin
  from public.members;

-- ---------------------------------------------------------------------------
-- Row Level Security: read-only for everyone, no direct writes.
-- All writes must go through the RPC functions below.
-- ---------------------------------------------------------------------------

alter table public.members enable row level security;
alter table public.bookings enable row level security;

drop policy if exists "members readable by everyone" on public.members;
create policy "members readable by everyone"
  on public.members for select
  using (true);

drop policy if exists "bookings readable by everyone" on public.bookings;
create policy "bookings readable by everyone"
  on public.bookings for select
  using (true);

-- ---------------------------------------------------------------------------
-- RPC functions (all SECURITY DEFINER, all verify the password before writing)
-- ---------------------------------------------------------------------------

-- One-time password setup. Fails if a password is already set (so it can't be used to
-- hijack someone else's name later) - an admin can clear pin_hash in the
-- Supabase table editor to let someone re-set a forgotten password.
create or replace function public.set_pin(p_member_name text, p_pin text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_member members;
begin
  if length(p_pin) < 6 then
    raise exception 'Password must be at least 6 characters';
  end if;

  select * into v_member from members where name = p_member_name;
  if v_member.id is null then
    raise exception 'Unknown family member: %', p_member_name;
  end if;
  if v_member.pin_hash is not null then
    raise exception 'A password is already set for % - ask an admin to reset it', p_member_name;
  end if;

  update members set pin_hash = crypt(p_pin, gen_salt('bf')) where id = v_member.id;
end;
$$;

-- Lets the app give immediate "wrong password" feedback when someone identifies
-- themselves, before they try to book/edit/delete anything.
create or replace function public.verify_pin(p_member_name text, p_pin text)
returns boolean
language sql
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1 from members
    where name = p_member_name
      and pin_hash is not null
      and pin_hash = crypt(p_pin, pin_hash)
  );
$$;

create or replace function public.add_booking(
  p_member_name text,
  p_pin text,
  p_start date,
  p_end date,
  p_note text default null
) returns bookings
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_member members;
  v_booking bookings;
begin
  select * into v_member from members where name = p_member_name;
  if v_member.id is null then
    raise exception 'Unknown family member: %', p_member_name;
  end if;
  if v_member.pin_hash is null then
    raise exception 'No password set yet for % - set one first', p_member_name;
  end if;
  if v_member.pin_hash <> crypt(p_pin, v_member.pin_hash) then
    raise exception 'Incorrect password for %', p_member_name;
  end if;

  begin
    insert into bookings (member_id, start_date, end_date, note)
    values (v_member.id, p_start, p_end, p_note)
    returning * into v_booking;
  exception
    when exclusion_violation then
      raise exception 'Those dates overlap with an existing booking';
  end;

  return v_booking;
end;
$$;


create or replace function public.add_booking_for_member(
  p_actor_member_name text,
  p_pin text,
  p_target_member_name text,
  p_start date,
  p_end date,
  p_note text default null
) returns bookings
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_actor members;
  v_target members;
  v_booking bookings;
begin
  select * into v_actor from members where name = p_actor_member_name;
  if v_actor.id is null then
    raise exception 'Unknown family member: %', p_actor_member_name;
  end if;
  if v_actor.pin_hash is null or v_actor.pin_hash <> crypt(p_pin, v_actor.pin_hash) then
    raise exception 'Incorrect password for %', p_actor_member_name;
  end if;
  if not v_actor.is_admin then
    raise exception 'Only admins can create bookings for another member';
  end if;

  select * into v_target from members where name = p_target_member_name;
  if v_target.id is null then
    raise exception 'Unknown family member: %', p_target_member_name;
  end if;

  begin
    insert into bookings (member_id, start_date, end_date, note)
    values (v_target.id, p_start, p_end, p_note)
    returning * into v_booking;
  exception
    when exclusion_violation then
      raise exception 'Those dates overlap with an existing booking';
  end;

  return v_booking;
end;
$$;
create or replace function public.update_booking(
  p_booking_id uuid,
  p_member_name text,
  p_pin text,
  p_start date,
  p_end date,
  p_note text default null
) returns bookings
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_member members;
  v_existing bookings;
  v_booking bookings;
begin
  select * into v_member from members where name = p_member_name;
  if v_member.id is null then
    raise exception 'Unknown family member: %', p_member_name;
  end if;
  if v_member.pin_hash is null or v_member.pin_hash <> crypt(p_pin, v_member.pin_hash) then
    raise exception 'Incorrect password for %', p_member_name;
  end if;

  select * into v_existing from bookings where id = p_booking_id;
  if v_existing.id is null then
    raise exception 'Booking not found';
  end if;
  if v_existing.member_id <> v_member.id and not v_member.is_admin then
    raise exception 'You can only edit your own bookings';
  end if;

  begin
    update bookings
      set start_date = p_start, end_date = p_end, note = p_note
      where id = p_booking_id
      returning * into v_booking;
  exception
    when exclusion_violation then
      raise exception 'Those dates overlap with an existing booking';
  end;

  return v_booking;
end;
$$;

create or replace function public.delete_booking(
  p_booking_id uuid,
  p_member_name text,
  p_pin text
) returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_member members;
  v_existing bookings;
begin
  select * into v_member from members where name = p_member_name;
  if v_member.id is null then
    raise exception 'Unknown family member: %', p_member_name;
  end if;
  if v_member.pin_hash is null or v_member.pin_hash <> crypt(p_pin, v_member.pin_hash) then
    raise exception 'Incorrect password for %', p_member_name;
  end if;

  select * into v_existing from bookings where id = p_booking_id;
  if v_existing.id is null then
    raise exception 'Booking not found';
  end if;
  if v_existing.member_id <> v_member.id and not v_member.is_admin then
    raise exception 'You can only delete your own bookings';
  end if;

  delete from bookings where id = p_booking_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants: anon (the public browser key) can read members_public + bookings,
-- and call the RPC functions. It gets no direct table write access.
-- ---------------------------------------------------------------------------

grant usage on schema public to anon, authenticated;
grant select on public.members_public to anon, authenticated;
grant select on public.bookings to anon, authenticated;
grant execute on function public.set_pin(text, text) to anon, authenticated;
grant execute on function public.verify_pin(text, text) to anon, authenticated;
grant execute on function public.add_booking(text, text, date, date, text) to anon, authenticated;
grant execute on function public.add_booking_for_member(text, text, text, date, date, text) to anon, authenticated;
grant execute on function public.update_booking(uuid, text, text, date, date, text) to anon, authenticated;
grant execute on function public.delete_booking(uuid, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Seed your family members here. Run this after the statements above.
-- Everyone starts with no password set - they set their own via the app on first use.
-- ---------------------------------------------------------------------------

insert into public.members (name, is_admin) values
   ('Admin', true),
   ('Angela', false),
   ('Gaia', false),
   ('Marta', false),
   ('Monica', false),
   ('Mattia', false),
   ('Nora', false),
   ('Chiara', false),
   ('Michele', false),
   ('Simone', false),
   ('Cecilia', false),
   ('Paola', false),
   ('Milo', false);





