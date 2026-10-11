# Daily Rossura backups

Use full daily snapshots for this small database. Each JSON contains all members
(including password hashes and admin flags) and bookings from one SQL statement's
consistent snapshot. No pagination or incremental deletion tracking is required.
The generated `during` column is omitted because Postgres recreates it on restore.
After the member-view migration, snapshots also contain a generated `has_pin`
boolean. Restore ignores this derived field and Postgres recreates it from the
password hash; old snapshots without it work with the updated schema too.
The script keeps 30 days, with at least two newest copies, and only expires old
copies after verifying a new file. Expired files go to Drive Trash.

## Setup

1. Run `supabase/backup.sql` once in your project's Supabase SQL Editor.
2. Create a private Drive folder just for these backups. Copy its folder ID from
   the URL (the part after `/folders/`). Do not use a public/shared family folder:
   backups include password hashes and private data.
3. Create a standalone project at https://script.google.com and paste `Code.gs`
   into its code editor. No web app deployment or Google Sheet is needed.
4. In Project Settings > Script Properties add:

   | Property | Value |
   | --- | --- |
   | SUPABASE_URL | `https://your-project-ref.supabase.co` |
   | SUPABASE_SECRET_KEY | A dedicated `sb_secret_...` key from Supabase Settings > API Keys |
   | BACKUP_FOLDER_ID | Your private Drive folder ID |

   The secret key is privileged across the project, not restricted to these
   tables. Keep the script private, restrict its editors, and never put this key
   in `config.js`, Git, a Sheet cell, or chat. The SQL function grants execution
   only to `service_role`; browser/public keys cannot call it.
5. Run `runDailyBackup` manually and approve Google's requested access. Open the
   JSON in Drive and confirm member/booking counts and fields match Supabase.
6. Run `installDailyTrigger`. It schedules daily execution in the 03:00 hour in
   Europe/Zurich; Google does not promise an exact minute. In Apps Script's
   Triggers screen set failure notifications to notify immediately.
7. Optionally run `installHealthCheckTrigger` for a small read every six hours.
   This generates database activity but does not guarantee protection against
   Supabase Free project pausing. Watch Supabase warning emails.

Apps Script's Executions screen shows failures and backup file links. Script
Properties record the last successful backup timestamp, file ID, and counts.
`LAST_BACKUP_ERROR` records the latest failed backup. A row-count drop of more
than half sets `RETENTION_WARNING` and pauses expiration of old backups while
still saving new snapshots. Review the data, then remove that Script Property
when retention should resume. With the optional independent health trigger, a
last backup older than 36 hours causes a trigger failure notification. This
cannot detect both triggers being disabled or losing access to the Google account.
Trigger failures use Google's notification system; hard timeouts may not allow
your code to finish. Periodically check the actual dated files exist.

## Recovery and scope

These are complete snapshots of the two application tables, not full Postgres or
Supabase project backups. Keep a separate copy of this repository and the current
database schema, policies, functions, and settings. If you changed the live schema
outside this repo, export that schema too using Supabase's CLI backup guidance.
Auth users, Storage files, other tables, and platform configuration are not
included. This repository currently uses no Supabase Auth or Storage.

Restore first into a disposable Supabase project, with the original table
definitions and functions from `schema.sql`; do not run `seed.sql`.
Generate a private, reviewable restore file:

```sh
node backup/build-restore.cjs snapshot.json restore-private.sql
```

The tool validates the snapshot and generates one SQL transaction, preserving
IDs, password hashes, admin flags and creation timestamps. It never connects to
Supabase or modifies the input file. The SQL refuses to run if members/bookings
are non-empty and lets Postgres regenerate `during`. Run it using a trusted SQL
tool in your disposable project. Keep both JSON and SQL private; the default
`restore*.sql` filenames are ignored by Git. Confirm counts, foreign keys, login, and booking dates
before switching the app's project URL/key. The script never writes to Supabase.

New snapshots include `schema_version: 1`. Older format-version-1 snapshots
without this field remain supported when their records match the current schema.

Test this recovery procedure before relying on these exports. Retain a known
good snapshot separately before a major change. Daily backups mean up to about
24 hours of changes can be lost, longer if jobs fail.

Apps Script currently has a six-minute execution limit and a 50 MB URL Fetch
response limit. This whole-response method suits the small booking app; switch
to scheduled CLI/Postgres dumps when size or runtime grows. Incremental backups
would need a reliable change/deletion log and an unbroken restore chain; the
current tables have no general `updated_at` or deletion log.

References:
- https://developers.google.com/apps-script/guides/triggers/installable
- https://developers.google.com/apps-script/guides/services/quotas
- https://supabase.com/docs/guides/getting-started/api-keys
- https://supabase.com/docs/guides/platform/backups
