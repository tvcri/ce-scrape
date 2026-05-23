#!/usr/bin/env node
/**
 * fetch-srids.js
 *
 * Fetches all srp_srid values from the CE Member Services listing page (page 650),
 * handling ASP.NET UpdatePanel pagination automatically.
 *
 * The search criteria (date range, filters) are session-driven — set them in the
 * browser first, then capture fresh cookies before running.
 *
 * Output: one srp_srid per line to stdout or --output file
 *
 * Usage:
 *   node fetch-srids.js --cookies "COOKIE_STRING"
 *   node fetch-srids.js --cookie-file cookies.txt
 *   node fetch-srids.js --cookie-file cookies.txt --output srids.txt
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
    cookies:       { type: 'string' },
    'cookie-file': { type: 'string' },
    delay:         { type: 'string', default: '1000' },
    output:        { type: 'string' },
    'club-id':     { type: 'string', default: '908317' },
    'page-id':     { type: 'string', default: '650' },
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

const DELAY_MS = parseInt(args.delay, 10);
const CLUB_ID  = args['club-id'];
const PAGE_ID  = args['page-id'];
const BASE_URL = `https://villagecommonri.org/content.aspx?page_id=${PAGE_ID}&club_id=${CLUB_ID}&actr=3`;

const out = args.output
  ? createWriteStream(args.output, { encoding: 'utf8' })
  : process.stdout;

// ---------------------------------------------------------------------------
// Static Telerik tokens (tied to CE's deployed version, not session-specific)
// ---------------------------------------------------------------------------
const TSSM = ';Telerik.Web.UI, Version=2018.2.710.45, Culture=neutral, PublicKeyToken=121fae78165ba3d4:en-US:8b7d6a7a-6133-413b-b622-bbc1f3ee15e4:92753c09:91f742eb:1c2121e:e24b8e95';
const TSM  = ';;System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35:en-US:ba1d5018-bf9d-4762-82f6-06087a49b5f6:ea597d4b:b25378d2;Telerik.Web.UI:en-US:8b7d6a7a-6133-413b-b622-bbc1f3ee15e4:16e4e7cd:365331c3:24ee1bba:ed16cbdc:874f8ea2:c128760b:19620875:b2e06756:92fe8ea0:fa31b949:4877f69a:33715776:f46195d3:490a9d4e:bd8f85e4:2003d0b8:88144a7a:1e771326:aa288e2d:258f1c72;';

// ---------------------------------------------------------------------------
// Shared fetch headers
// ---------------------------------------------------------------------------
const COMMON_HEADERS = {
  'Accept-Language':  'en-US,en;q=0.9',
  'Cache-Control':    'no-cache',
  'Cookie':           cookieString,
  'Origin':           'https://villagecommonri.org',
  'Pragma':           'no-cache',
  'Referer':          BASE_URL,
  'User-Agent':       'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  'sec-ch-ua':        '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract srp_srid values from SR listing HTML, filtered to rows where
 * the service name starts with "Ride:".
 *
 * Each repeater row contains both the edit link (with srp_srid) and a
 * .service-name div as siblings within .service-request-details.
 * Falls back to regex extraction if no .service-request-details rows found
 * (e.g. partial UpdatePanel response with different structure).
 */
function extractSrids(html) {
  const root = parse(html);
  const rows = root.querySelectorAll('.service-request-details');

  if (rows.length > 0) {
    const srids = [];
    for (const row of rows) {
      const serviceNameEl = row.querySelector('.service-name');
      if (!serviceNameEl) continue;
      const serviceName = serviceNameEl.text.trim();
      if (!serviceName.startsWith('Ride:')) continue;
      const editLink = row.querySelector('a[href*="srp_srid="]');
      if (!editLink) continue;
      const m = editLink.getAttribute('href').match(/srp_srid=(\d+)/);
      if (m) srids.push(m[1]);
    }
    return [...new Set(srids)];
  }

  // Fallback: partial response may not have full DOM structure — use regex
  // but warn so we know filtering didn't apply
  process.stderr.write('WARN: .service-request-details not found, falling back to unfiltered regex extraction\n');
  const matches = html.matchAll(/srp_srid=(\d+)/g);
  return [...new Set([...matches].map(m => m[1]))];
}

/** Extract a hidden input value by name from a parsed root. */
function hiddenValue(root, name) {
  const el = root.querySelector(`input[name="${name}"]`);
  return el ? (el.getAttribute('value') ?? '') : '';
}

/**
 * Parse total page count from either pagination style:
 * - Dropdown style: "Page 1 of 8" option text (larger result sets)
 * - Link style: numbered anchor links goToPage('N') (smaller result sets)
 */
function parseTotalPages(html) {
  const dropdownMatch = html.match(/Page \d+ of (\d+)/);
  if (dropdownMatch) return parseInt(dropdownMatch[1], 10);

  const linkMatches = [...html.matchAll(/goToPage\('(\d+)'\)/g)];
  if (linkMatches.length) {
    return Math.max(...linkMatches.map(m => parseInt(m[1], 10)));
  }

  return 1;
}

/** Detect session expiry or unexpected response. */
function isValidResponse(html) {
  return html.includes('srp_srid=')
    || html.includes('paging-dd')
    || html.includes('paging-links')
    || html.includes('updatePanel|');
}

/**
 * Extract search filter fields dynamically from the parsed page 1 root.
 * This ensures the POST bodies for pages 2..N exactly match whatever
 * criteria were active in the browser session when the GET was made.
 */
function searchFilterFields(root) {
  // Helper: get value of a hidden or text input by name
  const inp = (name) => {
    const el = root.querySelector(`input[name="${name}"]`);
    return el ? (el.getAttribute('value') ?? '') : '';
  };

  // Helper: get value of checked radio button by name
  const radio = (name) => {
    const el = root.querySelector(`input[name="${name}"][checked]`);
    return el ? (el.getAttribute('value') ?? '') : '';
  };

  // Helper: get display text of a RadComboBox by its Input child id
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
// Step 1: GET page 1 — capture VIEWSTATE and srids
// ---------------------------------------------------------------------------
process.stderr.write('GET page 1...\n');

const getRes = await fetch(BASE_URL, {
  headers: {
    'Accept':               'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Sec-Fetch-Dest':       'document',
    'Sec-Fetch-Mode':       'navigate',
    'Sec-Fetch-Site':       'same-origin',
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

if (!isValidResponse(page1Html)) {
  process.stderr.write('ERROR: Page 1 response looks like a login redirect or empty — check cookies.\n');
  process.exit(1);
}

const root1      = parse(page1Html);
const totalPages = parseTotalPages(page1Html);
const page1Srids = extractSrids(page1Html);

process.stderr.write(`Found ${totalPages} pages. Page 1: ${page1Srids.length} srids.\n`);
page1Srids.forEach(id => out.write(id + '\n'));

if (totalPages === 1) {
  process.stderr.write('Only one page — done.\n');
  if (args.output) out.end();
  process.exit(0);
}

// Capture VIEWSTATE for postbacks
let viewstate          = hiddenValue(root1, '__VIEWSTATE');
let viewstate1         = hiddenValue(root1, '__VIEWSTATE1');
let viewstate2         = hiddenValue(root1, '__VIEWSTATE2');
let viewstate3         = hiddenValue(root1, '__VIEWSTATE3');
let viewstateGenerator = hiddenValue(root1, '__VIEWSTATEGENERATOR');
let viewstateCount     = hiddenValue(root1, '__VIEWSTATEFIELDCOUNT');

// ---------------------------------------------------------------------------
// Step 2: POST for pages 2..N
// ---------------------------------------------------------------------------
for (let pageNum = 2; pageNum <= totalPages; pageNum++) {
  await sleep(DELAY_MS);
  process.stderr.write(`POST page ${pageNum} of ${totalPages}...\n`);

  const body = new URLSearchParams({
    'script_manager':          'ctl00$ctl00$ctl00$ctl00$search_criteria_divPanel|ctl00$ctl00$search_button',
    'style_sheet_manager_TSSM': TSSM,
    'script_manager_TSM':      TSM,
    'DES_Group':               '',
    ...searchFilterFields(root1),
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

  const postRes = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      'Accept':              '*/*',
      'Content-Type':        'application/x-www-form-urlencoded; charset=UTF-8',
      'Sec-Fetch-Dest':      'empty',
      'Sec-Fetch-Mode':      'cors',
      'Sec-Fetch-Site':      'same-origin',
      'X-MicrosoftAjax':    'Delta=true',
      'X-Requested-With':   'XMLHttpRequest',
      ...COMMON_HEADERS,
    },
    body: body.toString(),
    redirect: 'follow',
  });

  if (!postRes.ok) {
    process.stderr.write(`ERROR: POST page ${pageNum} failed with HTTP ${postRes.status}\n`);
    process.exit(1);
  }

  const pageHtml = await postRes.text();

  if (!isValidResponse(pageHtml)) {
    process.stderr.write(`ERROR: Page ${pageNum} response looks invalid — session may have expired.\n`);
    process.stderr.write(`Response preview: ${pageHtml.slice(0, 500)}\n`);
    process.exit(1);
  }

  const srids = extractSrids(pageHtml);
  process.stderr.write(`Page ${pageNum}: ${srids.length} srids.\n`);
  if (srids.length === 0) {
    process.stderr.write(`DEBUG page ${pageNum} preview: ${pageHtml.slice(0, 800).replace(/\n/g, ' ')}\n`);
  }
  srids.forEach(id => out.write(id + '\n'));

  // Refresh VIEWSTATE from partial response if present
  const updatedRoot = parse(pageHtml);
  const newVS = hiddenValue(updatedRoot, '__VIEWSTATE');
  if (newVS) {
    viewstate          = newVS;
    viewstate1         = hiddenValue(updatedRoot, '__VIEWSTATE1');
    viewstate2         = hiddenValue(updatedRoot, '__VIEWSTATE2');
    viewstate3         = hiddenValue(updatedRoot, '__VIEWSTATE3');
    viewstateGenerator = hiddenValue(updatedRoot, '__VIEWSTATEGENERATOR');
    viewstateCount     = hiddenValue(updatedRoot, '__VIEWSTATEFIELDCOUNT');
    process.stderr.write(`Page ${pageNum}: VIEWSTATE refreshed.\n`);
  } else {
    process.stderr.write(`Page ${pageNum}: VIEWSTATE not updated in response, carrying forward.\n`);
  }
}

process.stderr.write('Done.\n');
if (args.output) out.end();
