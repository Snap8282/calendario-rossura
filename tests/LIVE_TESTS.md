# Published-site tests against the real testing-phase database

This is a separate, manually invoked runner for the published Rossura site and
Supabase project `dpgsyjdoohegbpbzinff`. It performs real writes. It is not included
in `npm test`, the mocked browser suite, or GitHub Actions. Use it while this live
project is explicitly being used for testing, as authorized in this session.

## Run

Copy `tests/live-config.example.json` to `.live-test-config.json` in the project
root. Put the secret key already used by the Apps Script backup into `service_key`.
The local file and generated reports are Git-ignored. Do not paste the key into
chat or commit it. The browser receives only the site's ordinary public key;
the secret key is used by Node to create and remove temporary member accounts.
The secret needs SELECT/INSERT/DELETE access to `members`; no schema migration or
password reset is performed by this runner.

From the project folder:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests/run-live.ps1
```

The wrapper installs the pinned development dependencies on the local C: drive,
leaves the credential file in its original location, and prints the report path.
If local dependencies are already installed, the underlying command is:

```sh
node tests/live-user-actions.cjs /absolute/path/to/.live-test-config.json
```

## Coverage

The runner loads the actual published HTML, JavaScript and CSS. Requests reach the
real Supabase Data API. The browser's request interceptor blocks unapproved writes;
it does not replace successful API responses with mocks.

It creates one temporary admin and two temporary members with unique IDs/names,
then performs first-use password setup through the real login page. Passwords
are generated in memory, never written into the report. Existing accounts and
passwords are preserved.

Both admin and ordinary-member flows run in desktop Chromium and a Pixel 7-sized
touch context. Checks cover wrong-password feedback, login, creating a booking,
Swiss date display, editing dates/notes, persistence after page reload, overlap
warnings before submission, disabled booking controls, corrected dates, cancellation,
cancelled deletion, actual deletion and logout. Admin flows also create, edit and
delete on behalf of another member. A different member is checked for missing
edit/delete controls and rejected direct RPC edits/deletions. Additional real API
checks verify null-password rejection, overlapping-booking rejection, blocked
public password-hash reads and simultaneous reservations where exactly one succeeds.

All booking writes must use this run's marker and free test-date window. Edits and
deletions require a tracked test booking ID whose current member ID and note marker
still match. Initial free dates are selected from the full booking inventory within
the displayed calendar. The database remains responsible for concurrent conflicts.

## Cleanup and report

The runner tries cleanup in `finally`, including after a failed assertion. A marker
scan recovers created records whose browser response was lost. It deletes only its
marked bookings, then its temporary members, checking IDs, names and admin flags.
It refuses to delete a member while any booking remains for that member, preventing
the cascading foreign key from deleting untracked data. The original booking rows
are compared before/after; concurrent external edits can make this check fail and
are never automatically reversed.

`report.json` contains results and cleanup status. Failure screenshots are saved
locally; network traces are deliberately not recorded because they can contain
passwords. The final exit code is nonzero on a failed check or failed cleanup.
If cleanup fails, the report lists residual booking/member IDs for review.

Closing the terminal or losing power can interrupt cleanup. Temporary names begin
with `Autotest`, and notes start with the unique `ROSSURA_AUTOTEST_...` run marker;
review these exact records rather than clearing the database.

Mobile Chromium emulation exercises layout and touch interactions. It does not
reproduce every Android browser, native date picker, on-screen keyboard or device.
