# Calendario Casa Rossura

A small family booking calendar for Casa Rossura. It prevents overlapping
reservations and allows an administrator to manage bookings for everyone.

- **Calendar:** FullCalendar
- **Database:** Supabase Postgres
- **Hosting:** Static files on GitHub Pages
- **Build step:** None

## Security model

This app does not use Supabase Auth or personal accounts. A family member
selects their name and enters a password. The password is checked by
server-side database functions before any booking is created, changed, or
deleted.

This is a convenience lock for a private family calendar, not strong
authentication. Names, booking dates, and notes are readable through the
public application API. Do not put addresses, phone numbers, or other
sensitive information in booking notes.

The public Supabase key in config.js is expected to be visible. It cannot
write directly to the tables; writes go through password-checked functions
defined in supabase/schema.sql.

## Setup

1. Create a Supabase project.
2. Run supabase/schema.sql in the Supabase SQL Editor.
3. Add or update the family members in the public.members table.
4. Copy the Supabase project URL and anon key into config.js.
5. Publish the repository with GitHub Pages.

The seed member list at the bottom of schema.sql is intended for the first
setup. Running that insert again without changing it will produce duplicate
name errors.

## Using the calendar

- Select your name and enter your password.
- On first use, set a password of at least four characters.
- Click the check-in date, then click the checkout date.
- The darker cells are check-in and checkout; cells between them are lighter.
- The checkout day remains available as another booking's check-in day.
- Click a coloured booking bar to view its dates and note.
- Members can edit or delete their own bookings.
- Administrators can create and manage bookings for any member.
- Refreshing or closing the page signs you out.

## Password reset

There is no self-service reset. In Supabase, open public.members and clear
the member's pin_hash. That member can set a new password on the next login.

## Running locally

Open index.html directly in a browser. A static server also works:

~~~sh
npx serve .
~~~

## Files

- index.html: page structure and dialogs
- app.js: login, calendar, and booking behaviour
- style.css: responsive light and dark styling
- config.js: Supabase project URL and public key
- supabase/schema.sql: tables, policies, and booking functions
- vendor/: Supabase and FullCalendar, served from the repo rather than a
  CDN so the app has no third-party runtime dependency. See vendor/README.md
  before upgrading either library.
