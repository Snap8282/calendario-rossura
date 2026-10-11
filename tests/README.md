# Repeatable checks

These are development-only dependencies. The deployed site keeps its existing
static-file setup and does not need Node or a build step.

From an ordinary local checkout with Node 22+:

```sh
npm ci
npx playwright install chromium
npm test
npm run test:e2e
```

For this workspace on Google Drive, package extraction produced filesystem errors.
Use this PowerShell command instead; it stages only the UI and test sources under
`%LOCALAPPDATA%/RossuraReview/<unique-id>`, installs there, and runs both suites:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests/run-local.ps1
```

It retains that local directory so you can inspect failures. Each run is isolated.
No production credentials or backup JSON files are copied. The test server uses a
fake Supabase URL/key and Playwright blocks external traffic except mocked requests.

## What is covered

| Command | Tests | Purpose |
| --- | --- | --- |
| `npm run test:unit` | App domain logic and simulated Apps Script services | Date boundaries, colors, Drive verification, retention, failed exports, health checks |
| `npm run test:db` | In-memory PostgreSQL via PGlite with pgcrypto | Actual SQL functions, constraints, RLS, inherited grants, member/admin authorization, backup export and restore |
| `npm run test:e2e` | Headless Chromium with the actual HTML/JS and vendored libraries | Login, first password, create, admin booking, edit/delete, ownership controls, logout |

The tests assert intended behavior. The review baseline had nine failing checks;
the security-and-reliability branch fixes those requirements and extends coverage.
See `CODE_REVIEW.md` for historical baseline results and `CHANGES.md` for current
validation. The GitHub Actions workflow runs the isolated suites on pushes/PRs.

`npm run audit:live` is a separate, optional, read-only production check. It uses
the repo's public key and HEAD requests to verify public app reads work and
password hashes are inaccessible. It never downloads record values or writes
to Supabase. For the explicitly authorized testing phase of the live project,
`tests/run-live.ps1` provides a separate real-write suite with temporary accounts,
isolated booking IDs and verified cleanup. See `tests/LIVE_TESTS.md`; it never runs
automatically in the normal test commands or CI. Once the database holds real
family reservations, prefer a separate Supabase test project for write tests.

## Next coverage to add

PGlite runs PostgreSQL in one process; it is not a complete hosted Supabase stack.
Before deploying SQL changes, run a disposable Supabase project/local stack with:

- Real Data API tests of grants/RLS as `anon` and `authenticated`, including every
  write RPC with correct, wrong, empty and null passwords.
- The optional live runner verifies two concurrent overlapping reservations have
  exactly one winner. Extend this to concurrent edits/deletions as needed.
- Two simultaneous initial password setups: exactly one succeeds, and the loser
  cannot overwrite the winner. This needs separate connections.
- Hosted Data API pagination, timeouts, and schema changes. Slow/out-of-order
  responses, logout during a pending request, failed reads, and row caps are now
  covered in the isolated unit/browser suites.
- A full restore drill using a downloaded Drive snapshot, then browser tests
  against the restored project with synthetic member data.

The normal browser suite mocks the API so it proves browser behavior and RPC
arguments, not hosted authorization or cross-system wiring. The backup suite
mocks Google's services; Drive permissions, scheduling, timeout behavior and
notification emails still need an initial real Apps Script run.

Extend the browser matrix to mobile viewports, dark mode, and WebKit/Firefox
before changing calendar rendering or vendored libraries. Testing greatly reduces
regressions but cannot guarantee all possible behavior.
