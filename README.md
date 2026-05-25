# CE Ride Scraper

A Node.js scraper for extracting ride service request data from ClubExpress (CE), the platform used by The Village Common of Rhode Island (TVCRI).

## Why this scraper?

CE's Ad Hoc Reporting exports most ride service request fields, but omits two critical columns:
- **Appointment time** — when the member should be ready
- **Return pickup time** — for round-trip rides

This scraper fetches the SR detail pages directly to extract these missing fields, then outputs a CSV that can be joined to the Ad Hoc report for a complete dataset.

## Quick start

### Prerequisites

- Node.js (any recent version)
- An authenticated browser session in ClubExpress
- Ride service request data available in the CE Member Services listing

### Installation

```bash
npm install
```

### Running the scraper

1. **Get your session cookie:**
   - Log in to [ClubExpress Member Services](https://villagecommonri.org/content.aspx?page_id=650&club_id=908317&actr=3)
   - Open DevTools → Network tab
   - Reload the page and click the first request to Member Services
   - Copy as cURL and extract the cookie string (the `-b` value)
   - Save it to a file (e.g., `cookies.txt`)

2. **Set your search criteria in the browser:**
   - Filter by status, service type, date range as needed
   - **Important:** Sort by **Service Date** (not Create Date)
   - The scraper will use whatever filters are currently active in your session

3. **Run the scraper:**

```bash
node scrape-rides.js --cookie-file cookies.txt --output rides.csv
```

## Output

The scraper produces a CSV with these columns:

| Column | Source | Notes |
|--------|--------|-------|
| `srp_srid` | CE internal DB key | Used to identify the service request |
| `request_number` | Human-readable ID | Matches Ad Hoc report "Request Number" |
| `member_name` | Member account | |
| `metro_area` | Service location | Extracted from member details |
| `service` | Service type | E.g., "Ride: Medical" |
| `start_date` | Trip start date | Format: M/D/YYYY |
| `start_time` | Trip start time | 12-hour format (e.g., "2:30 PM") |
| `appointment_time` | Member ready time | 12-hour format |
| `return_pickup_time` | Return trip pickup time | 12-hour format |
| `finish_time` | Trip end time | 12-hour format |
| `finish_date` | Trip end date | Format: M/D/YYYY |

## CLI options

```
node scrape-rides.js [options]

Options:
  --cookie-file FILE      Path to file with session cookies (required)
  --cookies STRING        Cookie string inline (avoid; shell history risk)
  --output FILE           Output CSV file (default: stdout)
  --delay MS              Milliseconds between requests (default: 1000)
  --club-id ID            CE club ID (default: 908317)
  --list-page-id ID       Member Services page ID (default: 650)
  --sr-page-id ID         SR detail page ID (default: 660)
```

## How it works

The scraper operates in two phases:

**Phase 1 — Collect service request IDs**
- Fetches the Member Services listing page
- Captures VIEWSTATE and active search filters from the response
- Paginates through results, extracting `srp_srid` for all "Ride:" services
- Stops when a page returns no results (~7 pages typical)

**Phase 2 — Extract detail fields**
- For each collected srid, fetches the SR detail page
- Extracts appointment time and return pickup time (the missing fields)
- Writes all fields to CSV

## Important notes

### Session cookies
- Must be captured from an **authenticated browser session**
- Typically include: `ASP.NET_SessionId`, `SERVERID`, `MEMBER_TOKEN`
- Session lifetime is hours to days; the scraper detects expiry and exits gracefully
- Store cookies in a file to avoid shell history exposure

### Search filters are session-driven
- Whatever filters are active in your browser when you copy the cookie are what the scraper uses
- Change your date range, status, or service type in the CE UI before running
- The scraper reads filter values dynamically from the first page response

### Pagination limit
- CE stops returning results after ~7 pages (when sorted by Create Date)
- **Always sort by Service Date in the browser before running**
- This is the most common reason for missed records

### Date range limit
- CE enforces an undocumented rolling window: ~1 week past, ~6 weeks forward
- Ad Hoc Reports can go back 10 years, but this scraper is limited to the CE UI window
- Run the scraper **weekly** to avoid gaps in appointment time coverage

## Joining to Ad Hoc report

Once you have both CSVs, join them on `request_number`:

```sql
SELECT ah.*, sr.appointment_time, sr.return_pickup_time
FROM adhoc_report ah
LEFT JOIN rides_csv sr ON ah."Request Number" = sr.request_number;
```

## Debugging

Progress and errors go to stderr. CSV output goes to stdout (or `--output` file):

```bash
# Separate progress log from clean CSV
node scrape-rides.js --cookie-file cookies.txt --output rides.csv 2>run.log
```

Check `run.log` for:
- Number of pages fetched
- Number of service requests processed
- Session expiry or connection errors

## Technical details

See [CLAUDE.md](CLAUDE.md) for low-level details on ClubExpress platform architecture, VIEWSTATE handling, Telerik RadAjax behavior, and known gotchas.

## License

This scraper is for use by The Village Common of Rhode Island as part of the migration to Village Green.
