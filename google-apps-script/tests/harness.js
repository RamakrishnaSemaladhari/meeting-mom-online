// Minimal in-memory Google Apps Script runtime: enough to execute the real Code.gs end to end.
const vm = require('vm'), fs = require('fs');

function makeEnv(opts = {}) {
  const log = { fetches: [], driveWrites: [], sheetWrites: 0 };
  const props = Object.assign({}, opts.properties || {});
  const files = {};
  const rows = [[]];

  const sheet = {
    getName: () => 'Sheet1', getLastRow: () => rows.length > 1 || rows[0].length ? rows.length : 0,
    getMaxColumns: () => 40, insertColumnsAfter() {}, setFrozenRows() {}, setColumnWidth() {},
    appendRow(r) { rows.push(r.slice()); log.sheetWrites++; },
    getRange(r, c, nr = 1, nc = 1) {
      return {
        getValues: () => Array.from({length: nr}, (_, i) => Array.from({length: nc}, (_, j) => (rows[r - 1 + i] || [])[c - 1 + j] ?? ''),
        getValue: () => (rows[r - 1] || [])[c - 1] ?? '',
        setValue(v) { (rows[r - 1] = rows[r - 1] || [])[c - 1] = v; log.sheetWrites++; return this; },
        setValues(v) { v.forEach((row, i) => row.forEach((x, j) => { (rows[r - 1 + i] = rows[r - 1 + i] || [])[c - 1 + j] = x; })); return this; },
        setFontWeight() { return this; }, setWrap() { return this; }, setVerticalAlignment() { return this; }, setNumberFormat() { return this; },
      };
    },
  };
  const spreadsheet = { getId: () => 'SS', getName: () => 'MEETING_REGISTER', getSheetByName: () => sheet, getSheets: () => [sheet], insertSheet: () => sheet };
  const folder = (id) => ({
    getId: () => id, getUrl: () => 'https://drive/' + id, getName: () => id,
    createFolder: (n) => folder(id + '/' + n),
    getFilesByName: (n) => { const f = (files[id] || {})[n]; let used = false; return { hasNext: () => !!f && !used, next: () => { used = true; return { setContent(c) { files[id][n].content = c; log.driveWrites.push({ id, n, content: c }); }, getBlob: () => ({ getDataAsString: () => files[id][n].content }), getId: () => id + '::' + n, getUrl: () => 'u', setTrashed() {} }; } }; },
    getFiles: () => ({ hasNext: () => false }), getFolders: () => ({ hasNext: () => false }),
    createFile: (n, c) => { (files[id] = files[id] || {})[n] = { content: c }; log.driveWrites.push({ id, n, content: c }); return { getId: () => id + '::' + n, getUrl: () => 'u' }; },
  });
  const ctx = {
    console, Logger: { log() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null, setProperty: (k, v) => { props[k] = v; }, getProperties: () => props }) },
    SpreadsheetApp: { openById: () => spreadsheet },
    DriveApp: { getFolderById: (id) => folder(id), createFolder: (n) => folder('root/' + n), getFileById: (id) => ({ getId: () => id, getName: () => 'audio.m4a', getMimeType: () => 'audio/mp4', getSize: () => 1000, getParents: () => ({ hasNext: () => false }) }) },
    Drive: undefined,
    MimeType: { PLAIN_TEXT: 'text/plain', JSON: 'application/json', GOOGLE_DOCS: 'application/vnd.google-apps.document', FOLDER: 'application/vnd.google-apps.folder' },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ text: t, setMimeType() { return this; }, getContent: () => t }) },
    HtmlService: { createTemplateFromFile: () => ({ evaluate: () => ({ setTitle() { return this; }, setXFrameOptionsMode() { return this; } }) }), XFrameOptionsMode: { ALLOWALL: 1 } },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
    Session: { getActiveUser: () => ({ getEmail: () => 'me@example.com' }), getScriptTimeZone: () => 'Asia/Kolkata' },
    Utilities: {
      formatDate: (d, tz, f) => d.toISOString(), getUuid: () => 'abcdef12-0000-0000-0000-000000000000', sleep() {},
      base64Encode: (x) => Buffer.from(x).toString('base64'), newBlob: (s) => ({ getDataAsString: () => s }),
    },
    UrlFetchApp: {
      fetch(url, o = {}) {
        log.fetches.push({ url, method: (o.method || 'get').toLowerCase(), body: o.payload ? JSON.parse(o.payload) : null });
        const r = opts.fetch ? opts.fetch(url, o) : null;
        if (r) return { getResponseCode: () => r.code, getContentText: () => r.text };
        if (/\/dispatches$/.test(url)) return { getResponseCode: () => 204, getContentText: () => '' };
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ workflow_runs: [], total_count: 0 }) };
      },
    },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/x/exec' }), newTrigger: () => ({ timeBased: () => ({ after: () => ({ create() {} }), everyMinutes: () => ({ create() {} }) }) }), getProjectTriggers: () => [], deleteTrigger() {} },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  return { ctx, log, props, files, rows };
}

function load(env, file) {
  vm.runInContext(fs.readFileSync(file, 'utf8'), env.ctx, { filename: file });
}
function post(env, body) {
  const out = vm.runInContext('doPost', env.ctx)({ postData: { contents: JSON.stringify(body) }, parameter: {} });
  return JSON.parse(out.text);
}
function get(env, params) {
  const out = vm.runInContext('doGet', env.ctx)({ parameter: params });
  return JSON.parse(out.text);
}
module.exports = { makeEnv, load, post, get };
