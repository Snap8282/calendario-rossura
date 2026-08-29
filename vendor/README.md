# Vendored libraries

These files are committed on purpose. The app previously loaded them from
jsDelivr at runtime, which meant two things we did not want:

- `@supabase/supabase-js@2` was a **version range**, not a version. jsDelivr
  resolved it to the newest 2.x on every request, so the code running in the
  family's browsers changed whenever Supabase published a release — with no
  diff to review and no way to reproduce an earlier state.
- A jsDelivr outage, or anything unexpected served from it, took the calendar
  down or ran in our users' browsers. There were no integrity hashes.

Serving them from the repo removes the third-party runtime dependency
entirely. GitHub Pages already hosts the rest of the site.

## Contents

| File | Package | Version |
| --- | --- | --- |
| `supabase-2.112.4.min.js` | `@supabase/supabase-js` (UMD) | 2.112.4 |
| `fullcalendar-6.1.15.min.js` | `fullcalendar` standard bundle | 6.1.15 |
| `fullcalendar-locale-it-6.1.15.min.js` | `@fullcalendar/core` locale `it` | 6.1.15 |

SHA-256:

```
9a8142ffedb319a3ac0d4a8a123c9c2f7ffdb0e1e86cd9553889911b647175f6  supabase-2.112.4.min.js
673b42b6c0032ca6d414afd7ea73989c9af479e9665765f77612c307f24ae9f3  fullcalendar-6.1.15.min.js
a127ba2af4ed586a52024c2e4cdb9dd9c7fa9cf698f660d84227242e14987d61  fullcalendar-locale-it-6.1.15.min.js
```

`supabase-2.112.4.min.js` was byte-identical to what `@2` resolved to at the
time of vendoring, so pinning changed no behaviour.

The FullCalendar standard bundle injects its own CSS at runtime — there is no
stylesheet to vendor alongside it. The locale file registers `it` into the same
global registry the bundle creates, so it must load *after* the bundle.

## Updating

Do this deliberately, not on a schedule. Download the exact version, replace the
file, update the `<script>` tag in `index.html`, update the table and hashes
above, and click through a booking before committing.

```sh
curl -sSfL "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@X.Y.Z/dist/umd/supabase.min.js" \
  -o vendor/supabase-X.Y.Z.min.js
curl -sSfL "https://cdn.jsdelivr.net/npm/fullcalendar@X.Y.Z/index.global.min.js" \
  -o vendor/fullcalendar-X.Y.Z.min.js
curl -sSfL "https://cdn.jsdelivr.net/npm/@fullcalendar/core@X.Y.Z/locales/it.global.min.js" \
  -o vendor/fullcalendar-locale-it-X.Y.Z.min.js

sha256sum vendor/*.js
```

Keeping the version in the filename means a stale `<script>` tag 404s loudly
instead of silently serving the old library.
