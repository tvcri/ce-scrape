/**
 * ce-platform.js
 *
 * Generic ClubExpress platform layer: ASP.NET VIEWSTATE handling, Telerik AJAX,
 * pagination, session management, and shared HTML parsing utilities.
 *
 * This module is not tied to any specific service type (rides, donations, etc.)
 * and can be reused by other CE scrapers.
 */

// ---------------------------------------------------------------------------
// Static Telerik tokens (tied to CE's deployed version, not session-specific)
// ---------------------------------------------------------------------------

export const TSSM = ';Telerik.Web.UI, Version=2018.2.710.45, Culture=neutral, PublicKeyToken=121fae78165ba3d4:en-US:8b7d6a7a-6133-413b-b622-bbc1f3ee15e4:92753c09:91f742eb:1c2121e:e24b8e95';
export const TSM  = ';;System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35:en-US:ba1d5018-bf9d-4762-82f6-06087a49b5f6:ea597d4b:b25378d2;Telerik.Web.UI:en-US:8b7d6a7a-6133-413b-b622-bbc1f3ee15e4:16e4e7cd:365331c3:24ee1bba:ed16cbdc:874f8ea2:c128760b:19620875:b2e06756:92fe8ea0:fa31b949:4877f69a:33715776:f46195d3:490a9d4e:bd8f85e4:2003d0b8:88144a7a:1e771326:aa288e2d:258f1c72;';

// ---------------------------------------------------------------------------
// HTML element helpers (generic, work with any parsed HTML)
// ---------------------------------------------------------------------------

export function hiddenValue(root, name) {
  const el = root.querySelector(`input[name="${name}"]`);
  return el ? (el.getAttribute('value') ?? '') : '';
}

export function attr(root, id, attribute) {
  const el = root.querySelector(`#${id}`);
  return el ? (el.getAttribute(attribute) ?? '').trim() : '';
}

export function text(root, id) {
  const el = root.querySelector(`#${id}`);
  return el ? el.text.trim() : '';
}

export function selectedOption(root, id) {
  const el = root.querySelector(`#${id} option[selected]`);
  return el ? el.text.trim() : '';
}

export function csvRow(fields) {
  return fields.map(f => {
    const s = String(f ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  }).join(',');
}

// ---------------------------------------------------------------------------
// VIEWSTATE helpers
// ---------------------------------------------------------------------------

export function readViewstate(root) {
  return {
    viewstate:          hiddenValue(root, '__VIEWSTATE'),
    viewstate1:         hiddenValue(root, '__VIEWSTATE1'),
    viewstate2:         hiddenValue(root, '__VIEWSTATE2'),
    viewstate3:         hiddenValue(root, '__VIEWSTATE3'),
    viewstateGenerator: hiddenValue(root, '__VIEWSTATEGENERATOR'),
    viewstateCount:     hiddenValue(root, '__VIEWSTATEFIELDCOUNT'),
  };
}

// ---------------------------------------------------------------------------
// HTTP request helpers
// ---------------------------------------------------------------------------

export async function ceGetPage(url, headers) {
  return fetch(url, {
    headers: {
      'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Sec-Fetch-Dest':            'document',
      'Sec-Fetch-Mode':            'navigate',
      'Sec-Fetch-Site':            'same-origin',
      'Upgrade-Insecure-Requests': '1',
      ...headers,
    },
    redirect: 'follow',
  });
}

export async function cePostPage(url, body, headers) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Accept':             '*/*',
      'Content-Type':       'application/x-www-form-urlencoded; charset=UTF-8',
      'Sec-Fetch-Dest':     'empty',
      'Sec-Fetch-Mode':     'cors',
      'Sec-Fetch-Site':     'same-origin',
      'X-MicrosoftAjax':   'Delta=true',
      'X-Requested-With':  'XMLHttpRequest',
      ...headers,
    },
    body: body.toString(),
    redirect: 'follow',
  });
}

// ---------------------------------------------------------------------------
// CE listing page helpers
// ---------------------------------------------------------------------------

export function isValidListResponse(html) {
  return html.includes('srp_srid=')
    || html.includes('paging-dd')
    || html.includes('paging-links')
    || html.includes('updatePanel|');
}

export function parseTotalPages(html) {
  const dropdownMatch = html.match(/Page \d+ of (\d+)/);
  if (dropdownMatch) return parseInt(dropdownMatch[1], 10);
  const linkMatches = [...html.matchAll(/goToPage\('(\d+)'\)/g)];
  if (linkMatches.length) {
    return Math.max(...linkMatches.map(m => parseInt(m[1], 10)));
  }
  return 1;
}

export function searchFilterFields(root) {
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
