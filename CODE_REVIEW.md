# Rossura code review — 10 October 2026

This document records the original baseline findings. Fixes on
`fix/security-and-reliability` and current test results are described in
[CHANGES.md](CHANGES.md). Live database changes still require applying the migration.

The date/ownership design is sound in its normal path, but the database password
checks and grants need attention before relying on the advertised password lock.
This review added automated checks and a backup Git ignore rule. It did not change
application behavior or deploy database changes.

## Findings, in priority order

### Critical: null password bypasses every booking write check

`supabase/schema.sql:134`, `:173`, `:218`, and `:261` use a comparison like
`pin_hash <> crypt(p_pin, pin_hash)`. With `p_pin = NULL`, `crypt` returns NULL,
the comparison becomes NULL, and PL/pgSQL's `IF` does not enter the rejection
branch. The preceding `pin_hash IS NULL` condition only protects accounts whose
stored hash is missing, not accounts with existing passwords.

In-memory PostgreSQL tests reproduced unauthorized create, edit and delete for
an existing member, plus booking on behalf of another member using the admin
name and a null password. The UI's login check does not protect direct RPC calls.
This is confirmed against repository SQL; no write probe was made against the
live project, and its deployed function definitions have not been inspected.

Fix: reject null/empty password arguments explicitly and use a null-safe hash
comparison (`IS DISTINCT FROM`). Apply consistently to all write functions and
ship a migration to the existing database. Re-run the four failing authorization
tests and hosted Data API checks.

### High: password hashes are readable through the live public API

`supabase/schema.sql:55` allows every row of `members` to be selected. The grants
section adds view/table access but never revokes inherited table grants. The
`members_public` view hides hashes only for clients choosing to use that view;
it cannot prevent a direct read of the underlying table.

A read-only request using the website's public key to
`members?select=id,pin_hash&limit=1` returned HTTP 200 and the requested columns.
Hash values were not displayed or saved. Thus the live project exposes password
hashes, which enables offline guessing even though they are not plaintext.

Fix: explicitly revoke underlying members-table privileges from browser roles
and PUBLIC; keep SELECT on `members_public` and `bookings`. Audit live grants,
including column-level grants, and recheck with `npm run audit:live`. Consider
resetting affected passwords after access is closed; the review cannot establish
whether anyone else fetched hashes previously.

### Medium: inherited privileges undermine the documented grants model

With legacy Supabase default grants, the schema leaves extra privileges in place.
The local public-role test could TRUNCATE bookings: RLS does not stop TRUNCATE.
This is a database-role privilege finding, not evidence that the ordinary REST
table API exposes a TRUNCATE endpoint. Direct INSERT/UPDATE/DELETE were blocked
by the current RLS policies in tests.

Fix: revoke excess grants explicitly before granting the desired SELECTs and
RPC execution. Restrict function execution deliberately rather than retaining
Postgres's default PUBLIC EXECUTE. Verify both fresh and existing installations.

### Medium: initial password setup is not atomic and accepts null

`supabase/schema.sql:80–92` checks the account then updates it in separate SQL
statements. Two requests can both observe an unset password and overwrite one
another. This is a code-level race finding; concurrency was not reproduced with
the single-connection test engine. A local test did confirm that null password
setup succeeds while leaving the account without a hash.

Fix: validate the argument and atomically update only when `pin_hash IS NULL`,
then check that exactly one row was changed, or lock the member row first.
An unset account can intentionally be claimed by anyone knowing the family URL;
initialize the admin password privately. There is no rate limiting or genuine
user authentication; retain the README's convenience-lock expectations, or use
Supabase Auth if stronger authentication is needed.

### Medium: booking loads can be incomplete or stale

`app.js:210` fetches every booking with one unpaginated query. Supabase's default
API row cap can silently omit later rows as history grows. The query also has no
deterministic ordering. The database overlap constraint remains effective, but
the display and client-side availability checks can be wrong.

Bookings are loaded on login and after this browser's writes, with no polling,
Realtime subscription, or refresh on focus. Another family member's changes do
not appear until reload. On load failure, the old cache remains (including after
logout), or an initially empty calendar looks available after the banner fades.

Fix: fetch the visible date range with pagination and deterministic ordering,
refresh on focus or offer refresh, and explicitly display loading/error/stale
state. Disable booking selection until the first load completes successfully.

### Medium: async actions have no protection against duplicate/stale responses

The login, password setup, create, save and delete handlers never disable their
buttons while awaiting requests. Double submission can cause duplicate requests,
one success followed by a misleading overlap/not-found error, and responses
arriving after a logout or account switch can change the UI unexpectedly.

Fix: add per-action busy state with `finally` cleanup and a session/request
generation guard. Refresh results after a successful write; distinguish a saved
booking followed by a failed refresh from a failed write. Add deferred-response
browser tests rather than only immediate mock responses.

### Low: logout does not clear modal state

`app.js:164` leaves both modals and `openEventId` untouched. A browser regression
test invoking the real logout handler while details are open leaves that dialog
over the login gate. The overlay normally blocks clicking the logout button in
this state, so this is an edge-case state-cleanup problem rather than the usual
logout flow. Clear dialogs, selected event, booking cache and password inputs on
logout; ignore outstanding responses from the former session.

### Medium: backup validation and recovery could be stronger

`backup/Code.gs:53` verifies containers, IDs and foreign keys, but accepts rows
missing required restore fields such as a member's name. It also does not check
date ordering, field types, or a real snapshot timestamp. A test supplying a
member without a name was accepted. Drive byte verification proves the saved
file matches the response, not that every field can be restored.

Fix: validate the versioned record contract fully and compare restored counts
and values during a scheduled restore drill. Keep a schema version alongside
snapshots. Retention runs after a verified save, which is good, but it will expire
older good data after repeated valid snapshots of an accidentally emptied
database. Keep occasional longer-term/offline copies and flag large count drops.

Health checks record only the latest success. A healthy SELECT does not prove
the backup export, Drive permissions, or schedule works. Failure emails cannot
detect a trigger that was removed and never runs. Monitor backup age separately.

### Maintenance: migration, recovery, and accessibility gaps

- `schema.sql` mixes definitions with seed inserts. Re-running produces duplicate
  names, and `CREATE TABLE IF NOT EXISTS` cannot migrate existing table layouts.
  Use numbered migrations and keep seed data separate.
- Before this review there was no automated test entry point or CI configuration.
  Tests now exist; CI still needs wiring after defects are fixed.
- Backups currently depend on one Google account and restore instructions rather
  than a restore command. Add a tested import tool and occasional external copy.
- The folder `backup/backup_folder` contained JSON exports; it was untracked and
  not ignored. Added `.gitignore` now excludes it. No evidence here of prior
  publication; an ignore rule does not remove already committed files elsewhere.
- Member colors depend on alphabetical order; inserting/renaming someone changes
  other colors. Store colors or derive them from stable IDs if consistency matters.
- Modal overlays lack dialog semantics, focus management and keyboard dismissal.
  Forms are button handlers, so Enter does not reliably submit. Add keyboard and
  accessibility browser checks.
- Library versions and hashes are documented, which is useful. Actual hashes
  match `vendor/README.md`. Git already showed two modified vendor files before
  review; they were not edited here. Keep deliberate update checks with a browser
  smoke suite and dependency/advisory monitoring.

## Test evidence

Executed against the repository baseline:

| Layer | Passed | Failed |
| --- | ---: | ---: |
| App unit/domain | 4 | 0 |
| Apps Script with mocked Google services | 8 | 1 |
| SQL integration in local PGlite PostgreSQL | 11 | 7 |
| Actual UI in headless Chromium, mocked API | 7 | 1 |
| Total | 30 | 9 |

Failures represent five null-handling cases, exposed hash grants, inherited
TRUNCATE privilege, incomplete backup validation, and modal state after logout.

Passing tests cover normal password verification/setup, valid and invalid booking
dates, checkout-day changeover, overlap rejection on create/update, owner/admin
permissions, wrong-password rejection, direct-write RLS, JSON backup permissions,
restore of member IDs/passwords/bookings, Drive readback verification, retention,
health checks, first-use UI, booking creation/edit/deletion and logout's usual flow.

This is not a full hosted integration/production audit. Browser responses and
Google services are mocked; PGlite is not the Supabase gateway or concurrent
multi-connection Postgres. All SQL writes ran against synthetic in-memory data.
The only live checks were reads using the existing public key. See
`tests/README.md` for commands and the next test layer.

## References

- PostgreSQL IF/null behavior: https://www.postgresql.org/docs/current/plpgsql-control-structures.html
- Supabase grants/RLS: https://supabase.com/docs/guides/database/postgres/row-level-security
- Supabase API row limit: https://supabase.com/docs/reference/javascript/select
- PGlite pgcrypto support: https://pglite.dev/extensions/
