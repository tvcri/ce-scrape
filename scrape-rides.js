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
// Static Telerik tokens (tied to CE's deployed version, not session-specific)
// ---------------------------------------------------------------------------
const TSSM = ';Telerik.Web.UI, Version=2018.2.710.45, Culture=neutral, PublicKeyToken=121fae78165ba3d4:en-US:8b7d6a7a-6133-413b-b622-bbc1f3ee15e4:92753c09:91f742eb:1c2121e:e24b8e95';
const TSM  = ';;System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35:en-US:ba1d5018-bf9d-4762-82f6-06087a49b5f6:ea597d4b:b25378d2;Telerik.Web.UI:en-US:8b7d6a7a-6133-413b-b622-bbc1f3ee15e4:16e4e7cd:365331c3:24ee1bba:ed16cbdc:874f8ea2:c128760b:19620875:b2e06756:92fe8ea0:fa31b949:4877f69a:33715776:f46195d3:490a9d4e:bd8f85e4:2003d0b8:88144a7a:1e771326:aa288e2d:258f1c72;';

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

function hiddenValue(root, name) {
  const el = root.querySelector(`input[name="${name}"]`);
  return el ? (el.getAttribute('value') ?? '') : '';
}

function attr(root, id, attribute) {
  const el = root.querySelector(`#${id}`);
  return el ? (el.getAttribute(attribute) ?? '').trim() : '';
}

function text(root, id) {
  const el = root.querySelector(`#${id}`);
  return el ? el.text.trim() : '';
}

function selectedOption(root, id) {
  const el = root.querySelector(`#${id} option[selected]`);
  return el ? el.text.trim() : '';
}

function metroArea(root) {
  const el = root.querySelector('#member_details_container');
  if (!el) return '';
  const m = el.text.match(/Metro Area:\s*([^\n\r]+)/);
  return m ? m[1].trim() : '';
}

function csvRow(fields) {
  return fields.map(f => {
    const s = String(f ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  }).join(',');
}

// ---------------------------------------------------------------------------
// Phase 1 helpers: listing page
// ---------------------------------------------------------------------------

function isValidListResponse(html) {
  return html.includes('srp_srid=')
    || html.includes('paging-dd')
    || html.includes('paging-links')
    || html.includes('updatePanel|');
}

function parseTotalPages(html) {
  const dropdownMatch = html.match(/Page \d+ of (\d+)/);
  if (dropdownMatch) return parseInt(dropdownMatch[1], 10);
  const linkMatches = [...html.matchAll(/goToPage\('(\d+)'\)/g)];
  if (linkMatches.length) {
    return Math.max(...linkMatches.map(m => parseInt(m[1], 10)));
  }
  return 1;
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
  // Fallback for partial UpdatePanel responses
  const matches = html.matchAll(/srp_srid=(\d+)/g);
  return [...new Set([...matches].map(m => m[1]))];
}

function searchFilterFields(root) {
  const inp = (name) => {
    const el = root.querySelector(`input[name="${name}"]`);
    return el ? (el.getAttribute('value') ?? '') : '';
  };
  const radio = (name) => {
    const el = root.querySelector(`input[name="${name}"][checked]`);
    return el ? (el.getAttribute('value') ?? '') : '';
  };
  const comboText = (inputId) => {
    const el = root.querySelector(`#${inputId}`);
    return el ? (el.getAttribute('value') ?? '') : '';
  };
  return {
    'changes_pending':                                        '',
    'ctl00_ctl00_member_service_manager_window_manager_ClientState': '',
    'ctl00$ctl00$member_id':                                  inp('ctl00$ctl00$member_id'),
    'ctl00$ctl00$member_name':                                inp('ctl00$ctl00$member_name'),
    'ctl00$ctl00$service_provider_id':                        inp('ctl00$ctl00$service_provider_id'),
    'ctl00$ctl00$service_provider_name':                      inp('ctl00$ctl00$service_provider_name'),
    'ctl00$ctl00$default_list_expanded':                      inp('ctl00$ctl00$default_list_expanded'),
    'ctl00$ctl00$service_request_type_dropdown':              comboText('ctl00_ctl00_service_request_type_dropdown_Input'),
    'ctl00_ctl00_service_request_type_dropdown_ClientState':  inp('ctl00_ctl00_service_request_type_dropdown_ClientState'),
    'ctl00$ctl00$service_category_dropdown':                  comboText('ctl00_ctl00_service_category_dropdown_Input'),
    'ctl00_ctl00_service_category_dropdown_ClientState':      inp('ctl00_ctl00_service_category_dropdown_ClientState'),
    'ctl00$ctl00$status_dropdown':                            comboText('ctl00_ctl00_status_dropdown_Input'),
    'ctl00_ctl00_status_dropdown_ClientState':                inp('ctl00_ctl00_status_dropdown_ClientState'),
    'ctl00$ctl00$provider_type_dropdown':                     comboText('ctl00_ctl00_provider_type_dropdown_Input'),
    'ctl00_ctl00_provider_type_dropdown_ClientState':         inp('ctl00_ctl00_provider_type_dropdown_ClientState'),
    'ctl00$ctl00$metro_area_dropdown':                        comboText('ctl00_ctl00_metro_area_dropdown_Input'),
    'ctl00_ctl00_metro_area_dropdown_ClientState':            inp('ctl00_ctl00_metro_area_dropdown_ClientState'),
    'ctl00$ctl00$service_request_number_from_text':           inp('ctl00$ctl00$service_request_number_from_text'),
    'ctl00$ctl00$service_request_number_to_text':             inp('ctl00$ctl00$service_request_number_to_text'),
    'ctl00$ctl00$dated_undated_requests_radiobuttonlist':     radio('ctl00$ctl00$dated_undated_requests_radiobuttonlist'),
    'ctl00$ctl00$sort_by_radiobuttonlist':                    radio('ctl00$ctl00$sort_by_radiobuttonlist'),
    'ctl00$ctl00$start_date_text':                            inp('ctl00$ctl00$start_date_text'),
    'ctl00$ctl00$finish_date_text':                           inp('ctl00$ctl00$finish_date_text'),
  };
}

// ---------------------------------------------------------------------------
// Phase 1: collect all ride srids from listing pages
// ---------------------------------------------------------------------------

process.stderr.write('=== Phase 1: collecting ride srids ===\n');
process.stderr.write('GET listing page 1...\n');

const getRes = await fetch(LIST_URL, {
  headers: {
    'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Sec-Fetch-Dest':            'document',
    'Sec-Fetch-Mode':            'navigate',
    'Sec-Fetch-Site':            'same-origin',
    'Upgrade-Insecure-Requests': '1',
    ...COMMON_HEADERS,
  },
  redirect: 'follow',
});

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

let viewstate          = hiddenValue(root1, '__VIEWSTATE');
let viewstate1         = hiddenValue(root1, '__VIEWSTATE1');
let viewstate2         = hiddenValue(root1, '__VIEWSTATE2');
let viewstate3         = hiddenValue(root1, '__VIEWSTATE3');
let viewstateGenerator = hiddenValue(root1, '__VIEWSTATEGENERATOR');
let viewstateCount     = hiddenValue(root1, '__VIEWSTATEFIELDCOUNT');
const filters          = searchFilterFields(root1);

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
    '__VIEWSTATE':             viewstate,
    '__VIEWSTATE1':            viewstate1,
    '__VIEWSTATE2':            viewstate2,
    '__VIEWSTATE3':            viewstate3,
    '__VIEWSTATEGENERATOR':    viewstateGenerator,
    '__VIEWSTATEFIELDCOUNT':   viewstateCount,
    '__ASYNCPOST':             'true',
    'RadAJAXControlID':        'ctl00_ctl00_ajax_manager',
  });

  const postRes = await fetch(LIST_URL, {
    method: 'POST',
    headers: {
      'Accept':             '*/*',
      'Content-Type':       'application/x-www-form-urlencoded; charset=UTF-8',
      'Sec-Fetch-Dest':     'empty',
      'Sec-Fetch-Mode':     'cors',
      'Sec-Fetch-Site':     'same-origin',
      'X-MicrosoftAjax':   'Delta=true',
      'X-Requested-With':  'XMLHttpRequest',
      ...COMMON_HEADERS,
    },
    body: body.toString(),
    redirect: 'follow',
  });

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
  const newVS = hiddenValue(updatedRoot, '__VIEWSTATE');
  if (newVS) {
    viewstate          = newVS;
    viewstate1         = hiddenValue(updatedRoot, '__VIEWSTATE1');
    viewstate2         = hiddenValue(updatedRoot, '__VIEWSTATE2');
    viewstate3         = hiddenValue(updatedRoot, '__VIEWSTATE3');
    viewstateGenerator = hiddenValue(updatedRoot, '__VIEWSTATEGENERATOR');
    viewstateCount     = hiddenValue(updatedRoot, '__VIEWSTATEFIELDCOUNT');
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
    const res = await fetch(url, {
      headers: {
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Sec-Fetch-Dest':  'document',
        'Sec-Fetch-Mode':  'navigate',
        'Sec-Fetch-Site':  'same-origin',
        ...COMMON_HEADERS,
      },
      redirect: 'follow',
    });

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

    const requestNumberRaw = text(root, 'ctl00_ctl00_service_request_number_row');
    if (!requestNumberRaw) {
      process.stderr.write(`SKIP ${srid}: request_number not found\n`);
      continue;
    }

    const member_name = attr(root, 'ctl00_ctl00_member_name', 'value');
    if (!member_name) {
      process.stderr.write(`SKIP ${srid}: no member name (foreign or empty SR)\n`);
      continue;
    }

    const row = {
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

  } catch (err) {
    process.stderr.write(`ERR ${srid}: ${err.message}\n`);
  }
}

process.stderr.write('Done.\n');
if (args.output) out.end();
