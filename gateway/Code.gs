const ROOT_FOLDER_ID = '1kfwyuKxXdywPy9jhZjghFI4yGJEwh-Yl';

const FOLDER_NAMES = [
  'INBOX',
  'PROCESSING',
  'COMPLETED',
  'TRANSCRIPTS',
  'TRANSLATIONS',
  'MOM',
  'ARCHIVE'
];

function doGet(e) {
  const action = e && e.parameter ? (e.parameter.action || 'health') : 'health';
  if (action === 'health') {
    return jsonResponse({
      ok: true,
      service: 'Meeting MoM Online Gateway',
      version: '1.1',
      status: 'ONLINE',
      timestamp: new Date().toISOString()
    });
  }
  if (action === 'folders') return jsonResponse({ok: true, folders: getMeetingFolders()});
  return jsonResponse({ok: false, error: 'Unknown action'});
}

function doPost(e) {
  try {
    if (!e || !e.postData) return jsonResponse({ok: false, error: 'No POST data received'});
    const body = JSON.parse(e.postData.contents || '{}');
    const action = body.action || '';
    if (action === 'health') return jsonResponse({ok: true, service: 'Meeting MoM Online Gateway', status: 'ONLINE', timestamp: new Date().toISOString()});
    if (action === 'prepareMeeting') return jsonResponse(prepareMeeting(body));
    if (action === 'triggerProcessing') return jsonResponse(triggerGitHubProcessing(body));
    return jsonResponse({ok: false, error: 'Unknown action'});
  } catch (err) {
    return jsonResponse({ok: false, error: String(err)});
  }
}

function prepareMeeting(data) {
  const root = DriveApp.getFolderById(ROOT_FOLDER_ID);
  const folders = getOrCreateFolders(root);
  const now = new Date();
  const timezone = Session.getScriptTimeZone() || 'Asia/Kolkata';
  const stamp = Utilities.formatDate(now, timezone, 'yyyyMMdd_HHmmss');
  const title = cleanName(data.title || 'Untitled Meeting');
  const meetingFolder = folders.INBOX.createFolder(stamp + '_' + title);
  const audioFolder = meetingFolder.createFolder('AUDIO');
  const transcriptFolder = meetingFolder.createFolder('TRANSCRIPT');
  const translationFolder = meetingFolder.createFolder('TRANSLATION');
  const aiFolder = meetingFolder.createFolder('AI');
  const momFolder = meetingFolder.createFolder('MOM');

  const metadata = {
    meeting_id: stamp,
    title: data.title || 'Untitled Meeting',
    date: data.date || '',
    start_time: data.start_time || '',
    end_time: data.end_time || '',
    venue: data.venue || '',
    agenda: data.agenda || '',
    participants: data.participants || [],
    language_mode: 'auto',
    created_at: new Date().toISOString()
  };

  const metadataFile = meetingFolder.createFile('meeting_metadata.json', JSON.stringify(metadata, null, 2), MimeType.PLAIN_TEXT);
  return {
    ok: true,
    meeting_id: stamp,
    meeting_folder_id: meetingFolder.getId(),
    meeting_folder_url: meetingFolder.getUrl(),
    audio_folder_id: audioFolder.getId(),
    transcript_folder_id: transcriptFolder.getId(),
    translation_folder_id: translationFolder.getId(),
    ai_folder_id: aiFolder.getId(),
    mom_folder_id: momFolder.getId(),
    metadata_file_id: metadataFile.getId(),
    status: 'READY_FOR_AUDIO'
  };
}

function getMeetingFolders() {
  const root = DriveApp.getFolderById(ROOT_FOLDER_ID);
  const folders = getOrCreateFolders(root);
  const result = {};
  Object.keys(folders).forEach(function(name) {
    result[name] = {id: folders[name].getId(), name: folders[name].getName(), url: folders[name].getUrl()};
  });
  return result;
}

function getOrCreateFolders(root) {
  const result = {};
  FOLDER_NAMES.forEach(function(name) {
    const iterator = root.getFoldersByName(name);
    result[name] = iterator.hasNext() ? iterator.next() : root.createFolder(name);
  });
  return result;
}

function cleanName(value) {
  return String(value).trim().replace(/[\\/:*?"<>|#%{}~&]/g, '_').replace(/\s+/g, ' ').substring(0, 120);
}

function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function triggerGitHubProcessing(data) {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) return {ok: false, error: 'GITHUB_TOKEN is not configured in Apps Script.'};

  const url = 'https://api.github.com/repos/RamakrishnaSemaladhari/meeting-mom-online/dispatches';
  const payload = {
    event_type: 'meeting-ready',
    client_payload: {
      meeting_id: data.meeting_id || '',
      meeting_folder_id: data.meeting_folder_id || '',
      audio_folder_id: data.audio_folder_id || '',
      audio_file_id: data.audio_file_id || '',
      metadata_file_id: data.metadata_file_id || ''
    }
  };

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  if (code === 204) return {ok: true, status: 'PROCESSING_STARTED', message: 'GitHub processing triggered automatically.', audio_file_id: data.audio_file_id || ''};
  return {ok: false, error: 'GitHub dispatch failed: HTTP ' + code + ' ' + response.getContentText()};
}
