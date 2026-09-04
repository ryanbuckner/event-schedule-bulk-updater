# Event Schedule Bulk Updater

A Wix dashboard app for bulk-editing a Wix Events schedule (agenda) — the list of sessions,
performances, or activities within one event. Instead of editing each schedule item one at a time
in the native Wix Events UI, this app puts the whole schedule in one editable grid, with bulk time
shifting, bulk add/delete, and CSV import/export.

This project was bootstrapped with [Create Wix App](https://www.npmjs.com/package/@wix/create-app).
Read more about it in the
[Wix CLI for Apps documentation](https://dev.wix.com/docs/build-apps/developer-tools/cli/get-started/about-the-wix-cli-for-apps).

## Setup 🔧

```console
npm install
```

## Available Scripts

```console
npm run dev
```

Starts the local development environment against a Wix dev site. Requires being logged in via
`npx wix login`, and the CLI-authenticated account must have access to both the app (in Dev
Center) and the target site.

Other scripts: `npm run build`, `npm run release`, `npm run preview`, `npm run typecheck`.

## What it does

Pick an event, then work on its schedule as a spreadsheet-style grid:

- **Item Name**, **Place**, **Start/End Date and Time**, **Tags**, and **Hidden** are all editable
  directly in the grid. Place sits under Start and Tags sits under End (each field gets a usable
  width instead of a cramped column of its own); Place suggests places already used elsewhere in
  the schedule, and Tags works like the native Wix editor — type a tag, press Tab, and it becomes
  a pill; drag a pill to reorder it. Hidden is a click-to-toggle eye icon (no header). Description
  and Time Zone aren't grid columns (Description doesn't fit bulk editing; Time Zone was cut to
  save space) — both stay fully readable and writable through CSV import/export.
- **Shift selected times**: check any rows, dial in an hours + minutes offset for Start and End
  independently, and the times update live as you type — no separate "Apply" step. The offset is
  always relative to each row's own saved time (dialing "Start by" from 15 to 20 lands on
  baseline+20, never baseline+35), and a shift that crosses midnight correctly rolls the calendar
  date over too.
- **Add Schedule Item**: add one or several new items at once. The first one defaults to 10
  minutes after the last scheduled item's end (or the event's own start time, if the schedule is
  still empty); each additional item defaults 10 minutes after the one before it.
- **Delete selected**: bulk delete, with an inline confirmation listing the item names before
  anything is removed.
- **Export CSV** / **Import CSV**: see [CSV format](#csv-format) below.

### Draft and Published schedules

Every change here — grid edits, bulk shifts, adds, deletes, CSV import — writes to the event's
**draft** schedule. The **published** schedule is what's actually visible to guests on the site's
Event Details page. Nothing goes live until you explicitly publish:

- **Publish schedule** (top-right of the page): makes the current draft live.
- **Discard draft changes**: throws away unpublished draft edits, reverting to what's currently
  published.

Both are disabled unless the draft actually differs from what's published.

Each row can show up to two independent status icons:

- 🟠 **Unsaved changes** — edited in the grid, not yet saved to the draft. Lost if you navigate
  away without saving.
- 🔵 **Unpublished changes** — saved to the draft, but guests still see the previously published
  schedule. (This one is schedule-wide, not tracked per item by the underlying API, so it's shown
  on every row whenever the schedule as a whole has unpublished changes.)

A legend at the bottom of the page explains both.

### Pricing

Free — every feature, no size limit: viewing, exporting, grid edits, bulk time shift, add,
delete, publish/discard, and CSV import.

### CSV format

Column headers, in order:

| Header | Notes |
| --- | --- |
| `ID` | The schedule item's ID. Blank on a new row → creates an item. Present but missing from a re-imported file → deletes that item (see [Sync semantics](#sync-semantics)). |
| `Item Name` | Required for new items. |
| `Description` | |
| `Place` | Stage or room name. |
| `Start Date` | `YYYY-MM-DD`, e.g. `2026-09-14`. Deliberately not a region-specific format like `MM/DD/YYYY` — that's ambiguous (`03/04/2026` could mean March 4 or April 3 depending on the reader), where an ISO-style date isn't. |
| `Start Time` | 24-hour `HH:MM`, e.g. `19:05`. Same reasoning as the date: unambiguous regardless of the reader's own locale. |
| `End Date` | Same format as Start Date. |
| `End Time` | Same format as Start Time. |
| `Time Zone` | IANA zone ID, e.g. `America/New_York`. Governs how the date/time columns above are interpreted. Required for new items. |
| `Tags` | Semicolon-separated, e.g. `keynote;featured`. |
| `Hidden` | `true`/`false` (also accepts `yes`/`no`, `1`/`0`). Hidden items don't appear in the schedule guests see. |
| `Status` | `SCHEDULED` or `CANCELED`. |

None of these are raw Zulu/UTC timestamps — every date and time column is the item's own local
wall-clock value, in the `Time Zone` column alongside it. Old files exported before a column was
renamed still import fine (the raw internal field name is accepted alongside the current label).

Starting from scratch? The Import panel has a **Download a template** link — the same columns as
an export, with one filled-in example row.

#### Sync semantics

Import is a sync against the live schedule, not a plain "add whatever's in the file":

- A row whose `ID` matches an existing item → **update**. Only the columns actually present in
  the file are changed — omit a column entirely and that field is left as the server has it. (For
  `Start Date` / `Start Time`, and likewise `End Date` / `End Time`: if only one half of the pair
  is in the file, the other half keeps its current value rather than being blanked.)
- A row with a blank `ID` → **create**.
- A live item whose `ID` doesn't appear anywhere in the file → **delete**.

Before anything is committed, the app shows exactly what will change — including the names of any
items that will be deleted — so nothing is destroyed silently.

### Time zones and locale

Every schedule item carries its own IANA time zone (from the event's configured zone), and that's
always what's used to interpret and display its date/time — not the browser's or the editor's own
time zone, and not a single site-wide setting. An organizer in Denver editing a London event works
in London wall-clock time.

Separately, how dates and times are *formatted* (12-hour vs. 24-hour, month name order, date
picker language) follows the Wix dashboard user's own **Language & Region** preference, read via
the Wix SDK — not a hardcoded locale. The CSV file itself is the one place that stays
locale-independent on purpose (see the CSV format note above), since a data file benefits from
being unambiguous no matter who opens it.
