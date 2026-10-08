// Offline tests for the Apps Script gateway (google-apps-script/Code.gs).
// Runs the REAL script in a mocked Google runtime:   node --test google-apps-script/tests
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makeEnv, load, post, get } = require('./harness');

const CODE = path.join(__dirname, '..', 'Code.gs');
const REQ = {
  action: 'start_processing', meeting_id: '20261007T165151Z_Untitled Meeting',
  meeting_folder_id: 'MEET1', audio_folder_id: 'AUD1', audio_file_id: 'AUDIO1',
  meeting_title: 'Untitled Meeting', processing_mode: 'fresh',
};

function control(env) {
  const w = env.log.driveWrites.filter((x) => x.n === 'CONTROL_STATUS.json');
  return w.length ? JSON.parse(w[w.length - 1].content) : null;
}

test('no function is declared twice (a nested/duplicated startProcessing_ once broke every request)', () => {
  const src = fs.readFileSync(CODE, 'utf8');
  const names = [...src.matchAll(/^\s*function\s+([A-Za-z0-9_$]+)\s*\(/gm)].map((m) => m[1]);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepStrictEqual([...new Set(dupes)], []);
});

test('health proves which code is deployed (version + capabilities)', () => {
  const env = makeEnv(); load(env, CODE);
  const h = get(env, { action: 'health' });
  assert.strictEqual(h.success, true);
  assert.match(h.version, /^control-tower-/);
  assert.ok(h.capabilities.includes('start_processing'));
});

test('start_processing dispatches meeting-ready with exact ids and processing_mode', () => {
  const env = makeEnv({ properties: { GITHUB_TOKEN: 'ghp_x' } }); load(env, CODE);
  const res = post(env, REQ);
  assert.strictEqual(res.success, true);
  const d = env.log.fetches.filter((f) => /\/dispatches$/.test(f.url));
  assert.strictEqual(d.length, 1);
  assert.strictEqual(d[0].body.event_type, 'meeting-ready');
  assert.deepStrictEqual(d[0].body.client_payload, {
    meeting_id: REQ.meeting_id, audio_folder_id: 'AUD1', meeting_folder_id: 'MEET1',
    audio_file_id: 'AUDIO1', processing_mode: 'fresh',
  });
  const c = control(env);
  assert.strictEqual(c.control_status, 'DISPATCHED');
  assert.strictEqual(c.processor.progress_percent, 5);
});

test('resume mode is forwarded to the workflow', () => {
  const env = makeEnv({ properties: { GITHUB_TOKEN: 'ghp_x' } }); load(env, CODE);
  post(env, Object.assign({}, REQ, { action: 'resume_processing', processing_mode: 'resume' }));
  const d = env.log.fetches.filter((f) => /\/dispatches$/.test(f.url));
  if (d.length) assert.strictEqual(d[0].body.client_payload.processing_mode, 'resume');
});

test('missing GITHUB_TOKEN is published to CONTROL_STATUS.json (the browser cannot read the HTTP reply)', () => {
  const env = makeEnv(); load(env, CODE);
  const res = post(env, REQ);
  assert.strictEqual(res.success, false);
  const c = control(env);
  assert.strictEqual(c.control_status, 'FAILED');
  assert.match(c.processor.message, /GITHUB_TOKEN/);
  assert.strictEqual(c.processor.error_code, 'GITHUB_DISPATCH');
});

for (const [code, expected] of [[401, /invalid or expired/], [403, /Contents: Read and write/], [404, /cannot see/], [422, /payload/]]) {
  test(`GitHub HTTP ${code} gives an actionable message in CONTROL_STATUS.json`, () => {
    const env = makeEnv({
      properties: { GITHUB_TOKEN: 'ghp_x' },
      fetch: (url) => (/\/dispatches$/.test(url) ? { code, text: '{"message":"x"}' } : null),
    });
    load(env, CODE);
    assert.strictEqual(post(env, REQ).success, false);
    const c = control(env);
    assert.strictEqual(c.control_status, 'FAILED');
    assert.match(c.processor.error_message, expected);
  });
}

test('audio_file_id is mandatory for online processing', () => {
  const env = makeEnv({ properties: { GITHUB_TOKEN: 'ghp_x' } }); load(env, CODE);
  const res = post(env, Object.assign({}, REQ, { audio_file_id: '' }));
  assert.strictEqual(res.success, false);
  assert.match(res.message, /Audio File ID/);
  assert.strictEqual(env.log.fetches.filter((f) => /\/dispatches$/.test(f.url)).length, 0);
});

test('unknown actions are reported, not swallowed', () => {
  const env = makeEnv(); load(env, CODE);
  assert.strictEqual(post(env, { action: 'nope' }).error, 'UNKNOWN_ACTION');
});
