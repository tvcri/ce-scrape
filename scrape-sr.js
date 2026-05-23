#!/usr/bin/env node
/**
 * scrape-sr.js
 *
 * Fetches CE Service Request pages and extracts fields not exposed via Ad Hoc Reporting.
 *
 * Output: CSV to stdout (or --output file)
 *   srp_srid, request_number, member_name,
 *   start_date, start_time, appointment_time, return_pickup_time, finish_time, finish_date
 *
 * Usage (range):
 *   node scrape-sr.js --start 1105341 --end 1105360 --cookie-file cookies.txt
 *
 * Usage (srid list):
 *   node scrape-sr.js --srid-file srids.txt --cookie-file cookies.txt [--output out.csv]
 *
 * Cookie string is the full value of the -b argument from your curl command.
 */

import { parse } from 'node-html-parser';
import { parseArgs } from 'node:util';
import { readFileSync, createWriteStream } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const { values: args } = parseArgs({
  options: {
    start:         { type: 'string' },
    end:           { type: 'string' },
    'srid-file':   { type: 'string' },
    cookies:       { type: 'string' },
    'cookie-file': { type: 'string' },
    delay:         { type: 'string', default: '1000' },
    output:        { type: 'string' },
    'club-id':     { type: 'string', default: '908317' },
    'page-id':     { type: 'string', default: '660' },
  },
});

// Build the srid list from whichever input mode was provided
let srids;
if (args['srid-file']) {
  srids = readFileSync(args['srid-file'], 'utf8')
    .split('\n')
    .map(s => s.trim())
    .filter(s => /^\d+$/.test(s));
  if (!srids.length) {
    console.error(`No valid srids found in ${args['srid-file']}`);
    process.exit(1);
  }
} else if (args.start && args.end) {
  const start = parseInt(args.start, 10);
  const end   = parseInt(args.end, 10);
  srids = Array.from({ length: end - start + 1 }, (_, i) => String(start + i));
} else {
  console.error('Provide either --srid-file or --start/--end');
  console.error('Usage: node scrape-sr.js --srid-file srids.txt --cookie-file cookies.txt [--output out.csv]');
  process.exit(1);
}

const DELAY_MS = parseInt(args.delay, 10);
const CLUB_ID  = args['club-id'];
const PAGE_ID  = args['page-id'];

let cookieString = args.cookies ?? '';
if (!cookieString && args['cookie-file']) {
  cookieString = readFileSync(args['cookie-file'], 'utf8').trim();
}
if (!cookieString) {
  console.error('Provide cookies via --cookies or --cookie-file');
  process.exit(1);
}

const out = args.output
  ? createWriteStream(args.output, { encoding: 'utf8' })
  : process.stdout;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const CSV_HEADER = 'srp_srid,request_number,member_name,metro_area,service,start_date,start_time,appointment_time,return_pickup_time,finish_time,finish_date';

function csvRow(fields) {
  return fields.map(f => {
    const s = String(f ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  }).join(',');
}

function attr(root, id, attribute) {
  const el = root.querySelector(`#${id}`);
  return el ? (el.getAttribute(attribute) ?? '').trim() : '';
}

function text(root, id) {
  const el = root.querySelector(`#${id}`);
  return el ? el.text.trim() : '';
}

/** Get the text of the selected <option> in a <select> element. */
function selectedOption(root, id) {
  const el = root.querySelector(`#${id} option[selected]`);
  return el ? el.text.trim() : '';
}

/** Extract Metro Area from the member details container text blob. */
function metroArea(root) {
  const el = root.querySelector('#member_details_container');
  if (!el) return '';
  const m = el.text.match(/Metro Area:\s*([^\n\r]+)/);
  return m ? m[1].trim() : '';
}

/**
 * Fetch one SR page and extract fields.
 * Returns null if the page looks like a redirect/login/404.
 */
async function fetchSR(srid) {
  const url = `https://villagecommonri.org/content.aspx?page_id=${PAGE_ID}&club_id=${CLUB_ID}&action=edit&srp_srid=${srid}&actr=3`;

  const res = await fetch(url, {
    headers: {
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control':   'no-cache',
      'Cookie':          cookieString,
      'User-Agent':      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      'Referer':         `https://villagecommonri.org/content.aspx?page_id=650&club_id=${CLUB_ID}&actr=3`,
    },
    redirect: 'follow',
  });

  if (!res.ok) {
    process.stderr.write(`SKIP ${srid}: HTTP ${res.status}\n`);
    return null;
  }

  const html = await res.text();

  if (html.includes('action=login') && !html.includes('service_request_number_row')) {
    process.stderr.write(`SKIP ${srid}: session expired or no SR found\n`);
    return null;
  }

  const root = parse(html);

  const requestNumberRaw = text(root, 'ctl00_ctl00_service_request_number_row');
  if (!requestNumberRaw) {
    process.stderr.write(`SKIP ${srid}: request_number not found\n`);
    return null;
  }

  const member_name = attr(root, 'ctl00_ctl00_member_name', 'value');
  if (!member_name) {
    process.stderr.write(`SKIP ${srid}: no member name (foreign or empty SR)\n`);
    return null;
  }

  return {
    srp_srid:           srid,
    request_number:     requestNumberRaw.replace(/^#/, ''),
    member_name,
    metro_area:         metroArea(root),
    service:            selectedOption(root, 'ctl00_ctl00_service_dropdown'),
    start_date:         attr(root, 'ctl00_ctl00_start_date', 'value'),
    start_time:         attr(root, 'ctl00_ctl00_start_time_picker_dateInput', 'value'),
    appointment_time:   attr(root, 'ctl00_ctl00_appointment_time_picker_dateInput', 'value'),
    return_pickup_time: attr(root, 'ctl00_ctl00_return_pickup_time_picker_dateInput', 'value'),
    finish_time:        attr(root, 'ctl00_ctl00_finish_time_picker_dateInput', 'value'),
    finish_date:        attr(root, 'ctl00_ctl00_finish_date', 'value'),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
process.stderr.write(`Processing ${srids.length} srids...\n`);
out.write(CSV_HEADER + '\n');

for (let i = 0; i < srids.length; i++) {
  const srid = srids[i];
  try {
    const row = await fetchSR(srid);
    if (row) {
      out.write(csvRow([
        row.srp_srid,
        row.request_number,
        row.member_name,
        row.metro_area,
        row.service,
        row.start_date,
        row.start_time,
        row.appointment_time,
        row.return_pickup_time,
        row.finish_time,
        row.finish_date,
      ]) + '\n');
      process.stderr.write(`OK  ${srid}: #${row.request_number} — ${row.member_name}\n`);
    }
  } catch (err) {
    process.stderr.write(`ERR ${srid}: ${err.message}\n`);
  }

  if (i < srids.length - 1) await sleep(DELAY_MS);
}

process.stderr.write('Done.\n');
if (args.output) out.end();
