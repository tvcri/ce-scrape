# CE Ride Scraper — Claude Code Context

## Project purpose

This project scrapes ride service request data from the ClubExpress (CE) platform used by The Village Common of Rhode Island (TVCRI). CE's Ad Hoc Reporting exports most fields but omits appointment time and return pickup time. This scraper fills that gap by fetching the SR detail pages directly.

The output CSV is joined to an Ad Hoc report CSV on `request_number` to produce a complete dataset for analysis and eventual migration to Village Green (the open-source replacement platform).

---

## The target platform: ClubExpress

CE is an ASP.NET WebForms application using:

- **Telerik RadAjaxManager** for AJAX pagination (not standard UpdatePanel)
- **ASP.NET VIEWSTATE** split across 4 hidden fields (`__VIEWSTATE`, `__VIEWSTATE1`, `__VIEWSTATE2`, `__VIEWSTATE3`)
- **Session-driven search state** — search criteria live server-side, keyed by `ASP.NET_SessionId`
- **CE club ID**: `908317` (TVCRI)
- **Listing page**: `page_id=650` (Member Services)
- **SR detail page**: `page_id=660` (edit view)

### srp_srid

`srp_srid` is CE's internal database key for service requests. It is a **global autoincrement** across all CE clubs — TVCRI records are sparse within a large shared namespace. It is not exposed via Ad Hoc Reporting. The join key between the scraper CSV and Ad Hoc CSV is `request_number` (human-readable, prefixed with `#` in the UI).

---

## The main script: scrape-rides.js

Single integrated script. No external dependencies beyond `node-html-parser`.

```bash
npm install node-html-parser
node scrape-rides.js --cookie-file cookies.txt --output rides.csv
```

### CLI options

| Option | Default | Description |
|--------|---------|-------------|
| `--cookie-file` | — | Path to file containing browser cookie string |
| `--cookies` | — | Cookie string inline (avoid; shell history risk) |
| `--output` | stdout | CSV output file path |
| `--delay` | `1000` | Milliseconds between requests |
| `--club-id` | `908317` | CE club ID |
| `--list-page-id` | `650` | Member Services listing page |
| `--sr-page-id` | `660` | SR detail/edit page |

### Two-phase execution

**Phase 1** — Listing page pagination:
1. GET `page_id=650` to fetch page 1 and capture VIEWSTATE + filter state
2. POST subsequent pages using `__EVENTTARGET=ctl00$ctl00$search_button` and `__EVENTARGUMENT=<pageNum>`
3. Extract `srp_srid` values only from rows where `.service-name` starts with `"Ride:"`
4. Stop gracefully if a page returns no results (CE pagination cap ~7 pages)

**Phase 2** — SR detail page extraction:
For each collected srid, GET `page_id=660&action=edit&srp_srid=<id>` and extract:

| CSV field | CE element ID | Notes |
|-----------|---------------|-------|
| `srp_srid` | URL param | CE's internal DB key |
| `request_number` | `ctl00_ctl00_service_request_number_row` | Text content, `#` stripped |
| `member_name` | `ctl00_ctl00_member_name` | Hidden input `value` attr |
| `metro_area` | `#member_details_container` | Regex on text: `Metro Area: <value>` |
| `service` | `ctl00_ctl00_service_dropdown` | Selected `<option>` text |
| `start_date` | `ctl00_ctl00_start_date` | `value` attr, format `M/D/YYYY` |
| `start_time` | `ctl00_ctl00_start_time_picker_dateInput` | `value` attr, 12-hour display |
| `appointment_time` | `ctl00_ctl00_appointment_time_picker_dateInput` | `value` attr, 12-hour display |
| `return_pickup_time` | `ctl00_ctl00_return_pickup_time_picker_dateInput` | `value` attr, 12-hour display |
| `finish_time` | `ctl00_ctl00_finish_time_picker_dateInput` | `value` attr, 12-hour display |
| `finish_date` | `ctl00_ctl00_finish_date` | `value` attr, format `M/D/YYYY` |

**Note on time pickers**: CE's hidden `rdfd_` machine-readable inputs (format `2026-05-22-13-00-00`) always carry today's date regardless of the actual service date — they are unreliable for the date component. The `_dateInput` display values (`1:00 PM`) are used instead, combined with the separate `start_date`/`finish_date` fields.

---

## Cookie handling

Cookies must be captured from a live authenticated browser session. The cookie string is the full `-b` value from a curl export (DevTools → Copy as cURL):

```
MEMBER_TOKEN=...; ASP.NET_SessionId=...; SERVERID=...
```

Save to `cookies.txt` (no quotes). The script does `.trim()` on load so trailing newlines are harmless.

**Minimum required cookies** (likely): `ASP.NET_SessionId` + `SERVERID`. `MEMBER_TOKEN` may also be required. `_ga*`, `_gid`, `__zlcmid`, `exagoantiforgerytoken` are analytics/chat and not needed.

**Session lifetime** appears long (hours to days in practice). The script detects expiry by checking for `action=login` in the response and exits cleanly, writing whatever CSV rows were already produced.

---

## Known CE platform behaviors and gotchas

### Pagination cap
CE stops returning results panel updates after approximately page 7 when sorted by **Create Date**. Pages beyond that return only the search criteria panel (`search_criteria_divPanel`) with 0 results. **Always use Service Date sort** in the browser before running. This is the single most important operational constraint.

### Search criteria are session-driven
The date range, status filters, and sort order are stored server-side. Whatever the browser had active when you copied the cookies is what the scraper will use. `searchFilterFields()` reads these dynamically from the page 1 GET response — it does not hardcode them.

### UI date range limitation
The CE Web UI has an undocumented rolling window constraint independent of the date range fields. In practice it shows approximately **~1 week into the past** and **~6 weeks forward** (TVCRI does not enter requests more than ~6 weeks out, so the forward limit is not yet confirmed). Entering a broader date range in the UI returns no additional records — the window is enforced server-side. Ad Hoc Reports can go back 10 years. The scraper is therefore limited to this rolling window — run it at least weekly to avoid gaps in appointment time coverage.

### VIEWSTATE
CE splits VIEWSTATE across 4 fields. All 4 must be included in every POST. The partial UpdatePanel responses for pages 2+ do not include updated VIEWSTATE, so the page 1 values are carried forward throughout the run. This works in practice.

### Telerik tokens (TSSM, TSM)
`style_sheet_manager_TSSM` and `script_manager_TSM` are static strings tied to CE's deployed Telerik version (`2018.2.710.45`). If CE upgrades Telerik, these will need to be recaptured from a fresh DevTools curl. They are hardcoded constants at the top of the script.

### Foreign srids
Since `srp_srid` is a global autoincrement, fetching unknown srids returns CE pages for other clubs showing `request_number = #1` with no member name. The script skips these via the member name guard. This is only relevant when using `--srid-file` with a range; the integrated script collects srids only from the listing page and doesn't encounter this issue.

### RadComboBox display text
CE uses Telerik RadComboBox widgets for dropdowns. The actual `<select>` is hidden; the visible display text lives in a sibling `<input class="rcbInput">` with ID `{dropdown_id}_Input`. Filter field values are read from these input elements, not from the hidden ClientState JSON (except for the ClientState fields themselves which must be passed verbatim).

---

## Workflow

1. Navigate to `https://villagecommonri.org/content.aspx?page_id=650&club_id=908317&actr=3` in Chrome
2. Set search criteria: **Service Date** sort, current month date range, desired status/type filters
3. DevTools → Network → copy the listing page request as cURL
4. Extract the `-b` cookie string into `cookies.txt`
5. Run: `node scrape-rides.js --cookie-file cookies.txt --output rides.csv`
6. Join `rides.csv` to Ad Hoc report CSV on `request_number` ↔ `"Request Number"`

Progress goes to stderr; clean CSV goes to stdout or `--output`. Redirect them independently if needed:

```bash
node scrape-rides.js --cookie-file cookies.txt --output rides.csv 2>run.log
```
