#!/usr/bin/env node
/**
 * scrape-rides.js
 *
 * Integrated scraper for TVCRI ride service requests.
 *
 * Phase 1: GET the Member Services listing page (650), paginate through all
 *   pages collecting srp_srid values for Ride: requests only.
 *
 * Phase 2: For each srid, fetch the SR detail page (660) and extract fields
 *   not exposed via Ad Hoc Reporting.
 *
 * Search criteria (date range, filters) are session-driven — set them in the
 * browser first (Service Date sort), then capture fresh cookies before running.
 *
 * Output: CSV to stdout or --output file
 *
 * Usage:
 *   node scrape-rides.js --cookie-file cookies.txt
 *   node scrape-rides.js --cookie-file cookies.txt --output rides.csv
 *   node scrape-rides.js --cookies "COOKIE_STRING" --output rides.csv
 */

import { parse } from 'node-html-parser';
import { parseArgs } from 'node:util';
import { readFileSync, createWriteStream } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  hiddenValue, attr, text, selectedOption, csvRow,
  isValidListResponse, parseTotalPages, searchFilterFields,
  readViewstate, ceGetPage, cePostPage,
  TSSM, TSM,
} from './ce-platform.js';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const { values: args } = parseArgs({
  options: {
    cookies:        { type: 'string' },
    'cookie-file':  { type: 'string' },
    delay:          { type: 'string', default: '1000' },
    output:         { type: 'string' },
    'club-id':      { type: 'string', default: '908317' },
    'list-page-id': { type: 'string', default: '650' },
    'sr-page-id':   { type: 'string', default: '660' },
  },
});

let cookieString = args.cookies ?? '';
if (!cookieString && args['cookie-file']) {
  cookieString = readFileSync(args['cookie-file'], 'utf8').trim();
}
if (!cookieString) {
  console.error('Provide cookies via --cookies or --cookie-file');
  process.exit(1);
}

const DELAY_MS   = parseInt(args.delay, 10);
const CLUB_ID    = args['club-id'];
const LIST_URL   = `https://villagecommonri.org/content.aspx?page_id=${args['list-page-id']}&club_id=${CLUB_ID}&actr=3`;
const SR_BASE    = `https://villagecommonri.org/content.aspx?page_id=${args['sr-page-id']}&club_id=${CLUB_ID}&action=edit&actr=3`;

const out = args.output
  ? createWriteStream(args.output, { encoding: 'utf8' })
  : process.stdout;

// ---------------------------------------------------------------------------
// Shared request headers
// ---------------------------------------------------------------------------
const COMMON_HEADERS = {
  'Accept-Language':  'en-US,en;q=0.9',
  'Cache-Control':    'no-cache',
  'Cookie':           cookieString,
  'Origin':           'https://villagecommonri.org',
  'Pragma':           'no-cache',
  'Referer':          LIST_URL,
  'User-Agent':       'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  'sec-ch-ua':        '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function metroArea(root) {
  const el = root.querySelector('#member_details_container');
  if (!el) return '';
  const m = el.text.match(/Metro Area:\s*([^\n\r]+)/);
  return m ? m[1].trim() : '';
}

function extractSrDetail(root) {
  return {
    request_number:     text(root, 'ctl00_ctl00_service_request_number_row').replace(/^#/, ''),
    member_name:        attr(root, 'ctl00_ctl00_member_name', 'value'),
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

function extractSrids(html) {
  const root = parse(html);
  const rows = root.querySelectorAll('.service-request-details');
  if (rows.length > 0) {
    const srids = [];
    for (const row of rows) {
      const serviceNameEl = row.querySelector('.service-name');
      if (!serviceNameEl) continue;
      if (!serviceNameEl.text.trim().startsWith('Ride:')) continue;
      const editLink = row.querySelector('a[href*="srp_srid="]');
      if (!editLink) continue;
      const m = editLink.getAttribute('href').match(/srp_srid=(\d+)/);
      if (m) srids.push(m[1]);
    }
    return [...new Set(srids)];
  }
  // Fallback for partial UpdatePanel responses: only match srids near 'Ride:' text
  const matches = html.matchAll(/Ride:[^\n]*?srp_srid=(\d+)/g);
  return [...new Set([...matches].map(m => m[1]))];
}

// ---------------------------------------------------------------------------
// Phase 1: collect all ride srids from listing pages
// ---------------------------------------------------------------------------

process.stderr.write('=== Phase 1: collecting ride srids ===\n');
process.stderr.write('GET listing page 1...\n');

const getRes = await ceGetPage(LIST_URL, COMMON_HEADERS);

if (!getRes.ok) {
  process.stderr.write(`ERROR: GET failed with HTTP ${getRes.status}\n`);
  process.exit(1);
}

const page1Html = await getRes.text();

if (!isValidListResponse(page1Html)) {
  process.stderr.write('ERROR: Listing page response looks like a login redirect — check cookies.\n');
  process.exit(1);
}

const root1      = parse(page1Html);
const totalPages = parseTotalPages(page1Html);
const allSrids   = extractSrids(page1Html);

process.stderr.write(`Found ${totalPages} page(s). Page 1: ${allSrids.length} ride srids.\n`);

let vs       = readViewstate(root1);
const filters = searchFilterFields(root1);

for (let pageNum = 2; pageNum <= totalPages; pageNum++) {
  await sleep(DELAY_MS);
  process.stderr.write(`POST listing page ${pageNum} of ${totalPages}...\n`);

  const body = new URLSearchParams({
    'script_manager':          'ctl00$ctl00$ctl00$ctl00$search_criteria_divPanel|ctl00$ctl00$search_button',
    'style_sheet_manager_TSSM': TSSM,
    'script_manager_TSM':      TSM,
    'DES_Group':               '',
    ...filters,
    '__EVENTTARGET':           'ctl00$ctl00$search_button',
    '__EVENTARGUMENT':         String(pageNum),
    '__LASTFOCUS':             '',
    '__VIEWSTATE':             vs.viewstate,
    '__VIEWSTATE1':            vs.viewstate1,
    '__VIEWSTATE2':            vs.viewstate2,
    '__VIEWSTATE3':            vs.viewstate3,
    '__VIEWSTATEGENERATOR':    vs.viewstateGenerator,
    '__VIEWSTATEFIELDCOUNT':   vs.viewstateCount,
    '__ASYNCPOST':             'true',
    'RadAJAXControlID':        'ctl00_ctl00_ajax_manager',
  });

  const postRes = await cePostPage(LIST_URL, body, COMMON_HEADERS);

  if (!postRes.ok) {
    process.stderr.write(`ERROR: POST page ${pageNum} failed with HTTP ${postRes.status} — stopping pagination.\n`);
    break;
  }

  const pageHtml = await postRes.text();

  if (!isValidListResponse(pageHtml)) {
    process.stderr.write(`WARN: Page ${pageNum} response looks invalid — stopping pagination early.\n`);
    break;
  }

  const pageSrids = extractSrids(pageHtml);
  process.stderr.write(`Page ${pageNum}: ${pageSrids.length} ride srids.\n`);
  allSrids.push(...pageSrids);

  // Refresh VIEWSTATE if present in partial response
  const updatedRoot = parse(pageHtml);
  const newVS = readViewstate(updatedRoot);
  if (newVS.viewstate) {
    vs = newVS;
  }
}

const uniqueSrids = [...new Set(allSrids)];
process.stderr.write(`Phase 1 complete: ${uniqueSrids.length} unique ride srids collected.\n`);

// ---------------------------------------------------------------------------
// Phase 2: fetch SR detail pages and extract fields
// ---------------------------------------------------------------------------

process.stderr.write('=== Phase 2: fetching SR detail pages ===\n');

const CSV_HEADER = 'srp_srid,request_number,member_name,metro_area,service,start_date,start_time,appointment_time,return_pickup_time,finish_time,finish_date';
out.write(CSV_HEADER + '\n');

for (let i = 0; i < uniqueSrids.length; i++) {
  const srid = uniqueSrids[i];
  await sleep(DELAY_MS);

  try {
    const url = `${SR_BASE}&srp_srid=${srid}`;
    const res = await ceGetPage(url, COMMON_HEADERS);

    if (!res.ok) {
      process.stderr.write(`SKIP ${srid}: HTTP ${res.status}\n`);
      continue;
    }

    const html = await res.text();

    if (html.includes('action=login') && !html.includes('service_request_number_row')) {
      process.stderr.write(`WARN: Session expired at srid ${srid} — writing partial results and stopping.\n`);
      break;
    }

    const root = parse(html);
    const detail = extractSrDetail(root);

    if (!detail.request_number) {
      process.stderr.write(`SKIP ${srid}: request_number not found\n`);
      continue;
    }

    if (!detail.member_name) {
      process.stderr.write(`SKIP ${srid}: no member name (foreign or empty SR)\n`);
      continue;
    }

    out.write(csvRow([
      srid,
      detail.request_number,
      detail.member_name,
      detail.metro_area,
      detail.service,
      detail.start_date,
      detail.start_time,
      detail.appointment_time,
      detail.return_pickup_time,
      detail.finish_time,
      detail.finish_date,
    ]) + '\n');

    process.stderr.write(`OK  ${srid}: #${detail.request_number} — ${detail.member_name}\n`);

  } catch (err) {
    process.stderr.write(`ERR ${srid}: ${err.message}\n`);
  }
}

process.stderr.write('Done.\n');
if (args.output) out.end();
