# Security and reliability branch

Branch: `fix/security-and-reliability`.

## Result

- Null/empty/overlong passwords fail closed in all booking functions. First-use
  password setup uses an atomic conditional UPDATE. Password hashes and table
  write/TRUNCATE privileges are revoked from public roles, including inherited
  column-level grants. Public function execution is explicitly restricted.
- Function search paths put `pg_temp` last, protecting against temporary-table
  shadowing. Existing booking edit/delete operations lock the selected row.
- Calendar reads are filtered to the visible range and paginated until empty,
  with a deterministic ID order and offsets based on actual returned row counts.
  Complete results replace the cache atomically in the browser; failed pages do
  not partially overwrite it. Concurrent database changes during paginated reads
  can still affect the fetched set; later refreshes reconcile it and Postgres
  always enforces overlap constraints.
- Loading/failure status remains visible. Selection waits for a successful load;
  manual refresh, focus/tab return and a one-minute visible-tab refresh keep data
  current. Refresh pauses during open dialogs/actions. Requests have a 20-second
  deadline. An interrupted write may already have reached the server, so the UI
  directs users to verify results before retrying.
- Busy controls prevent duplicate actions; session/request guards ignore stale
  responses. Logout aborts pending reads, clears caches/password fields and closes
  dialogs. Dialogs have accessible names, focus trapping/restoration, Escape
  dismissal and Enter submission.
- Backup validation checks required fields, UUIDs, types, dates, timestamps,
  foreign keys, duplicate names/IDs and overlapping reservations. Schema version
  metadata, retention pause after large count drops, backup error status and a
  36-hour backup-age check improve recovery monitoring. The restore generator
  produces private SQL for an empty project and does not execute it.
- Seeds are separate from schema definitions. An existing-project migration and
  a CI workflow make updates and checks reproducible.
- `members_public` now uses `security_invoker`, respecting caller permissions and
  member RLS. A generated `has_pin` boolean permits a four-column read allowlist
  without allowing password-hash reads. The existing frontend response is unchanged.
- Reservation details show check-in and check-out on separate labelled lines,
  using Swiss date format (`dd.mm.yyyy`).
  Notes appear without a prefix only when present. Admin accounts remain selectable
  after the alphabetical family list in both member selectors, without account renames.

## Validation

All 56 automated checks passed locally: 9 app unit/domain checks, 12 simulated
Apps Script checks, 22 database behavior/security checks, 1 migration/restore
integration check and 12 headless Chromium checks.

The migration check adds legacy table and column grants to an existing populated
database, applies the migration twice, verifies data is unchanged, checks both
`anon` and `authenticated`, and exercises the restore generator's actual SQL.
It also verifies a restore into non-empty tables is rejected without data loss.
The view follow-up starts with the deployed owner-backed view and no `has_pin`
table column, applies both migrations twice in order, and verifies unchanged
original records, invoker permissions, hash restrictions and backup restoration.
An incompatible existing `has_pin` column is rejected transactionally. Additional
checks verify RLS for a caller with no row policy and automatic password-flag updates.

Tests use synthetic data. PGlite is single-connection PostgreSQL, browser APIs are
mocked, and Google services are simulated. Separate-connection concurrency tests,
hosted Supabase gateway tests and actual Apps Script scheduling/Drive integration
remain deployment validation tasks. Existing vendor files were not edited by
this branch's implementation.

## Rollout for your already-running Supabase project

1. Keep a recent private backup and a copy of the live schema/functions. Check
   that the current app uses the tables/signatures in this repository.
2. Review and run the entire file
   `supabase/migrations/202610100001_security_hardening.sql` in Supabase SQL Editor.
   It is transactional and repeatable. It does not recreate tables, insert seed
   members, delete bookings or reset passwords. Do not substitute `seed.sql`.
3. Run `npm run audit:live` from the real repo: public member-view/bookings reads
   must pass, and the password-hash read must be denied. Use a disposable project
   for write tests. Consider rotating member passwords after closing hash access;
   this branch does not reset anyone's password automatically.
   To resolve the `members_public` SECURITY DEFINER advisor warning, also run
   `supabase/migrations/202610110001_members_view_security.sql`, then rerun the
   audit and Supabase Security Advisor. This follow-up is repeatable, keeps all
   records/passwords and requires no frontend or Apps Script changes. Run
   migrations in filename order; if reapplying the first, reapply the second too.
   New backup JSON may include the generated `has_pin` field; the restore tool
   ignores it and PostgreSQL recomputes it. Older snapshots remain compatible.
4. Publish this branch's static files when ready. The SQL migration keeps the
   existing RPC signatures, so it also works with the prior frontend.
5. Run `supabase/backup.sql` to update the backup function's schema metadata, then
   replace the Apps Script code with `backup/Code.gs`. Existing properties and
   trigger handler names are retained. Run one real backup and inspect the file,
   counts, failure notifications and optional health check.
6. Restore a downloaded snapshot into a disposable prepared project using the
   generated SQL, and verify login and booking behavior before relying on recovery.

No live migration, password reset, deployment, push or merge was performed here.
The review's live hash-exposure finding remains until step 2 is applied.

## Remaining design decisions

The app still intentionally uses a family password lock, public booking reads and
unauthenticated first-use password setup. Moving to Supabase Auth/rate limiting
requires a separate design. Member colors still follow alphabetical ordering to
preserve the familiar palette; durable color assignments can be added separately.
Longer-term/off-account backups and a multi-browser/mobile visual test matrix are
also useful follow-ups.
