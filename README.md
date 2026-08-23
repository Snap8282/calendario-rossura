# Family Home Calendar

A simple bnb-style booking calendar for family members to reserve the family
home, without double-booking or accidentally editing someone else's
reservation.

- **Calendar**: [FullCalendar](https://fullcalendar.io/) (drag to select dates, click a booking to view/edit)
- **Data**: [Supabase](https://supabase.com/) (free hosted Postgres)
- **Hosting**: static files, works on GitHub Pages
- No build step, no framework - just `index.html` + `app.js` + `style.css`

## Security model - please read

This app does **not** use real logins (no email/password, no Supabase Auth
accounts). It's designed like a shared spreadsheet with a light lock on it:
each family member picks their name and sets a 4-digit PIN once. That PIN
stops accidental double-bookings and accidental edits to someone else's
booking - it is **not** meant to protect sensitive data, and there isn't any
sensitive data in this app (just names and date ranges).

Because of that:
- The Supabase **anon/public API key** in `config.js` is safe to commit. It
  only grants read access plus access to a handful of PIN-checked database
  functions - see `supabase/schema.sql`. It cannot write to the tables
  directly.
- Don't put real personal data (addresses, phone numbers, etc.) in the
  `note` field, since anyone with the link can read the calendar.

## One-time setup

1. **Create a Supabase project** at [supabase.com](https://supabase.com) (free tier is enough).
2. Open **SQL Editor** in your Supabase project, paste in the contents of
   [`supabase/schema.sql`](supabase/schema.sql), and run it.
3. Add your family members: still in the SQL Editor, run something like:
   ```sql
   insert into public.members (name, is_admin) values
     ('Alice', true),
     ('Bob', false),
     ('Carol', false);
   ```
   (There's a commented-out example at the bottom of `schema.sql` too.)
   Everyone starts with no PIN - they'll set their own the first time they
   use the app.
4. Get your API credentials: **Project Settings > API** - copy the
   **Project URL** and the **anon public** key.
5. Open `config.js` and paste them in:
   ```js
   const SUPABASE_URL = "https://xxxxxxxx.supabase.co";
   const SUPABASE_ANON_KEY = "eyJ...";
   ```
6. Push this repo to GitHub, then enable **GitHub Pages** (repo Settings >
   Pages > deploy from the branch/root).

That's it - share the GitHub Pages URL with your family.

## Using the app

- **First time**: click "Identify yourself to book", pick your name, and
  set a 4-digit PIN.
- **Returning**: pick your name and enter your PIN. Check "Remember me" to
  skip this next time on the same device.
- **Book**: drag across the dates you want on the calendar. The end date is
  the **checkout day** - it's not included in your stay, so the next family
  member can start their booking that same day.
- **Edit/delete**: click an existing booking. You'll only see Edit/Delete
  buttons for your own bookings, unless you're an admin (admins can manage
  everyone's bookings).
- Days that are already booked appear greyed out and can't be selected
  again - overlapping bookings are also rejected by the database itself, so
  it's not possible even if two people book at the same time.

## Forgot your PIN?

There's no self-service reset (kept intentionally simple). An admin can
clear it from Supabase: **Table Editor > members**, find your row, clear the
`pin_hash` cell. You'll be prompted to set a new PIN next time you identify
yourself.

## Running locally

Just open `index.html` in a browser, or serve the folder with any static
file server, e.g.:

```sh
npx serve .
```

## Files

- `index.html` - page structure and modals
- `app.js` - all app logic (identity, calendar, booking CRUD)
- `style.css` - styling
- `config.js` - your Supabase project URL + anon key
- `supabase/schema.sql` - database schema, security policies, and the
  PIN-checked functions used for all writes
