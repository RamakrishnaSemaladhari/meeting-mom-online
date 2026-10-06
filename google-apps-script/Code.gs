/**
 * Meeting MoM Online — Google Apps Script Control Tower
 *
 * Script Properties required:
 *   GITHUB_TOKEN
 *   GITHUB_OWNER = RamakrishnaSemaladhari
 *   GITHUB_REPO  = meeting-mom-online
 *
 * Optional:
 *   GITHUB_API_VERSION = 2026-03-10
 *
 * The browser never receives the GitHub token. Code.gs owns the GitHub
 * dispatch/cancel operations and writes a machine-readable CONTROL_STATUS.json
 * into the meeting's private Google Drive workspace.
 */

const DEFAULT_OWNER = 'RamakrishnaSemaladhari';
const DEFAULT_REPO = 'meeting-mom-online';
const API_BASE = 'https://api.github.com';

function props_() {
  const p = PropertiesService.getScriptProperties();
  return {
    token: p.getProperty('GITHUB_TOKEN') || '',
    owner: p.getProperty('GITHUB_OWNER') || DEFAULT_OWNER,
    repo: p.getProperty('GITHUB_REPO') || DEFAULT_REPO,
    apiVersion: p.getProperty('GITHUB_API_VERSION') || '2026-03-10'
  };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function now_() {
  return new Date().toISOString();
}

function github_(method, path, body) {
  const c = props_();
  if (!c.token) throw new Error('GITHUB_TOKEN is not configured in Script Properties.');

  const options = {
    method: method,
    muteHttpExceptions: true,
    headers: {
      Authorization: 'Bearer ' + c.token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': c.apiVersion
    }
  };
  if (body !== undefined) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(body);
  }

  const r = UrlFetchApp.fetch(API_BASE + path, options);
  const code = r.getResponseCode();
  const text = r.getContentText();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = {raw: text}; }
  if (code < 200 || code >= 300) {
    throw new Error('GitHub API ' + code + ': ' + (data.message || text || 'unknown error'));
  }
  return {code: code, data: data};
}

function findRun_(meetingId, startedMs) {
  const c = props_();
  const r = github_(
    'get',
    '/repos/' + encodeURIComponent(c.owner) + '/' + encodeURIComponent(c.repo) +
      '/actions/runs?event=repository_dispatch&per_page=20'
  );
  const runs = r.data.workflow_runs || [];
  const floor = startedMs - 30000;
  return runs.find(function(run) {
    const created = Date.parse(run.created_at || '') || 0;
    if (created < floor) return false;
    if (run.event !== 'repository_dispatch') return false;
    return true;
  }) || null;
}

function driveFolder_(id) {
  if (!id) throw new Error('meeting_folder_id is required.');
  return DriveApp.getFolderById(id);
}

function writeControlStatus_(meetingFolderId, status) {
  const folder = driveFolder_(meetingFolderId);
  const payload = JSON.stringify(status, null, 2);
  const files = folder.getFilesByName('CONTROL_STATUS.json');
  if (files.hasNext()) {
    files.next().setContent(payload);
  } else {
    folder.createFile('CONTROL_STATUS.json', payload, MimeType.PLAIN_TEXT);
  }
  return status;
}

function readDriveJson_(folderId, name) {
  const folder = driveFolder_(folderId);
  const files = folder.getFilesByName(name);
  if (!files.hasNext()) return null;
  try { return JSON.parse(files.next().getBlob().getDataAsString()); } catch (_) { return null; }
}

function startProcessing_(p) {
  const started = Date.now();
  if (!p.meeting_id || !p.meeting_folder_id || !p.audio_folder_id || !p.audio_file_id) {
    throw new Error('Incomplete processing payload. meeting_id, meeting_folder_id, audio_folder_id and audio_file_id are mandatory.');
  }

  const c = props_();
  const payload = {
    event_type: 'meeting-ready',
    client_payload: {
      meeting_id: String(p.meeting_id),
      meeting_folder_id: String(p.meeting_folder_id),
      audio_folder_id: String(p.audio_folder_id),
      audio_file_id: String(p.audio_file_id),
      metadata_file_id: String(p.metadata_file_id || '')
    }
  };

  writeControlStatus_(p.meeting_folder_id, {
    meeting_id: p.meeting_id,
    control_status: 'DISPATCHING',
    overall_percent: 20,
    message: 'Audio verified in Google Drive. Sending authenticated request to GitHub Actions.',
    verified: true,
    source: 'GOOGLE_APPS_SCRIPT',
    updated_at: now_()
  });

  github_(
    'post',
    '/repos/' + encodeURIComponent(c.owner) + '/' + encodeURIComponent(c.repo) + '/dispatches',
    payload
  );

  Utilities.sleep(1500);
  const run = findRun_(p.meeting_id, started);

  const result = {
    meeting_id: p.meeting_id,
    control_status: run ? 'GITHUB_CONFIRMED' : 'GITHUB_DISPATCHED',
    overall_percent: run ? 25 : 22,
    github: {
      run_id: run ? String(run.id) : '',
      status: run ? run.status : 'unknown',
      conclusion: run ? (run.conclusion || null) : null,
      html_url: run ? run.html_url : ''
    },
    verified: true,
    source: 'GOOGLE_APPS_SCRIPT',
    updated_at: now_(),
    message: run
      ? 'GitHub Actions run confirmed. Backend processing can now be tracked.'
      : 'GitHub dispatch accepted. Run ID will be discovered on the next status check.'
  };

  writeControlStatus_(p.meeting_folder_id, result);
  return result;
}

function cancelProcessing_(p) {
  if (!p.meeting_folder_id) throw new Error('meeting_folder_id is required.');
  if (!p.run_id) throw new Error('run_id is required to cancel GitHub processing.');

  const c = props_();
  github_(
    'post',
    '/repos/' + encodeURIComponent(c.owner) + '/' + encodeURIComponent(c.repo) +
      '/actions/runs/' + encodeURIComponent(String(p.run_id)) + '/cancel'
  );

  const result = {
    meeting_id: p.meeting_id || '',
    control_status: 'CANCEL_REQUESTED',
    overall_percent: Number(p.percent || 0),
    github: {run_id: String(p.run_id), status: 'cancel_requested'},
    verified: true,
    source: 'GOOGLE_APPS_SCRIPT',
    updated_at: now_(),
    message: 'Cancellation request sent to GitHub Actions.'
  };
  writeControlStatus_(p.meeting_folder_id, result);
  return result;
}

function status_(p) {
  if (!p.meeting_folder_id) throw new Error('meeting_folder_id is required.');

  const c = props_();
  const control = readDriveJson_(p.meeting_folder_id, 'CONTROL_STATUS.json') || {};
  const processor = readDriveJson_(p.meeting_folder_id, 'PROCESSING_STATUS.json') || {};
  let run = null;

  const runId = p.run_id || (control.github && control.github.run_id) || processor.github_run_id;
  if (runId) {
    try {
      run = github_(
        'get',
        '/repos/' + encodeURIComponent(c.owner) + '/' + encodeURIComponent(c.repo) +
          '/actions/runs/' + encodeURIComponent(String(runId))
      ).data;
    } catch (_) {}
  }

  const output = {
    meeting_id: p.meeting_id || control.meeting_id || processor.meeting_id || '',
    control_status: control.control_status || '',
    overall_percent: Number(processor.progress_percent || control.overall_percent || 5),
    processor: processor,
    github: run ? {
      run_id: String(run.id),
      status: run.status,
      conclusion: run.conclusion || null,
      created_at: run.created_at,
      started_at: run.run_started_at || null,
      updated_at: run.updated_at,
      html_url: run.html_url
    } : (control.github || {}),
    verified: !!(processor.meeting_id || control.meeting_id),
    source: 'GOOGLE_APPS_SCRIPT',
    updated_at: now_()
  };

  writeControlStatus_(p.meeting_folder_id, output);
  return output;
}

function doPost(e) {
  try {
    const p = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const action = String(p.action || '').toLowerCase();

    if (action === 'start_processing') return json_({ok: true, data: startProcessing_(p)});
    if (action === 'cancel_processing') return json_({ok: true, data: cancelProcessing_(p)});
    if (action === 'status') return json_({ok: true, data: status_(p)});

    throw new Error('Unknown action: ' + action);
  } catch (err) {
    return json_({ok: false, error: String(err && err.message || err)});
  }
}

function doGet(e) {
  const p = e && e.parameter ? e.parameter : {};
  try {
    if (String(p.action || '').toLowerCase() === 'status') {
      return json_({ok: true, data: status_(p)});
    }
    return json_({ok: true, service: 'Meeting MoM Control Tower', time: now_()});
  } catch (err) {
    return json_({ok: false, error: String(err && err.message || err)});
  }
}
