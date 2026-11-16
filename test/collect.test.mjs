import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createIntake } from '../src/server.mjs';
import { createProvider } from '../provider/server.mjs';

const fixture = await readFile(new URL('../fixtures/lesson.mid', import.meta.url));

async function withService(context) {
  const directory = await mkdtemp(join(tmpdir(), 'collect-'));
  const service = await createIntake(directory);
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  context.after(async () => {
    service.closeAllConnections();
    await new Promise(resolve => service.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${service.address().port}`, directory };
}

async function withProvider(context) {
  const provider = createProvider();
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  context.after(async () => {
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
  });
  return `http://127.0.0.1:${provider.address().port}`;
}

const postMidi = (base, bytes, headers = {}) => fetch(base + '/api/collect', {
  method: 'POST',
  headers: { 'content-type': 'audio/midi', ...headers },
  body: bytes,
});

const postJson = (base, payload) => fetch(base + '/api/collect', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});

test('自动入口直接接收多轨 MIDI，保留原始字节、事件顺序与音符区间', async context => {
  const { base } = await withService(context);
  const response = await postMidi(base, fixture, { 'x-recording': encodeURIComponent('lesson-1') });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.recording, 'lesson-1');
  assert.deepEqual(body.identity, { recording: 'lesson-1' });
  assert.equal(body.version, 1);
  assert.equal(body.analysis.complete, true);
  assert.equal(body.analysis.performanceComplete, true);
  assert.equal(body.analysis.performanceCertain, false);
  assert.equal(body.analysis.notes.length, 2);
  assert.equal(body.analysis.notes[0].soundingUntilMs, 1500);
  assert.equal(body.analysis.rawEvents.length, body.analysis.events.length);
  assert.equal(body.analysis.counts.ambiguities, 1);

  const records = await (await fetch(base + '/api/records')).json();
  assert.equal(records.length, 1);
  assert.equal(records[0].source, 'automatic');
  assert.deepEqual(records[0].identity, { recording: 'lesson-1' });
  assert.equal(records[0].versions.length, 1);
  assert.equal(records[0].versions[0].data.notes.length, 2);
  assert.equal(records[0].versions[0].data.events.length, body.analysis.events.length);

  const raw = await (await fetch(base + `/api/records/${records[0].receipt}`)).json();
  assert.equal(raw.versions.length, 1);
  const version = await (await fetch(base + `/api/records/${records[0].receipt}/1`)).json();
  assert.equal(version.version, 1);
  assert.equal(version.data.notes[0].soundingUntil, 960);
  const bytes = Buffer.from(await (await fetch(base + `/api/records/${records[0].receipt}/raw`)).arrayBuffer());
  assert.deepEqual(bytes, fixture);
});

test('按声部、音高与时间检索实际按过的键', async context => {
  const { base } = await withService(context);
  await postMidi(base, fixture, { 'x-recording': 'lesson-1' });
  const byPitch = await (await fetch(base + '/api/notes?pitch=60&channel=0')).json();
  assert.equal(byPitch.count, 2);
  assert.equal(byPitch.notes[0].recording, 'lesson-1');
  assert.equal(byPitch.notes[0].pressedMs, 0);
  assert.equal(byPitch.notes[1].endReason, 'sustain-pedal-up');
  const byTrack = await (await fetch(base + '/api/notes?track=2')).json();
  assert.equal(byTrack.count, 0);
  const byRecording = await (await fetch(base + '/api/notes?recording=lesson-1&from=200&to=300')).json();
  assert.equal(byRecording.count, 1);
  assert.equal(byRecording.notes[0].noteId, 'note-2');
  const invalid = await fetch(base + '/api/notes?pitch=abc');
  assert.equal(invalid.status, 400);
});

test('相同演奏与相同业务身份复用版本，不同演奏保留新版本', async context => {
  const { base } = await withService(context);
  const first = await (await postMidi(base, fixture, { 'x-recording': 'lesson-1' })).json();
  const duplicate = await (await postMidi(base, fixture, { 'x-recording': 'lesson-1' })).json();
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.version, first.version);
  const corrected = Buffer.from(fixture);
  corrected[0x30] = 0x14;
  const changed = await (await postMidi(base, corrected, { 'x-recording': 'lesson-1' })).json();
  assert.equal(changed.duplicate, false);
  assert.equal(changed.version, 2);
  const records = await (await fetch(base + '/api/records')).json();
  assert.equal(records[0].versions.length, 2);
});

test('自动入口拒绝非 MIDI 字节而不是当作演奏记录', async context => {
  const { base } = await withService(context);
  const response = await postMidi(base, Buffer.from('not midi'));
  assert.equal(response.status, 415);
  const body = await response.json();
  assert.equal(body.code, 'NOT_MIDI');
  const records = await (await fetch(base + '/api/records')).json();
  assert.equal(records.length, 0);
});

test('截断演奏仍被接收，但结果注明不完整与不确定边界', async context => {
  const { base } = await withService(context);
  const response = await postMidi(base, fixture.subarray(0, fixture.length - 5), { 'x-recording': 'lesson-1' });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.analysis.complete, false);
  assert.equal(body.analysis.performanceComplete, false);
  assert.equal(body.analysis.performanceCertain, false);
  assert.equal(body.analysis.openNotes.length, 2);
  assert.ok(body.diagnostics.some(item => item.code === 'truncated-track'));
  assert.equal(body.rawSha256.length, 64);
});

test('JSON 指令可从本地来源取回演奏，并保留相对链接解释', async context => {
  const { base } = await withService(context);
  const source = await withProvider(context);
  const response = await postJson(base, { source });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.collected.length, 1);
  assert.equal(body.collected[0].recording, 'lesson-1');
  assert.equal(body.collected[0].sourceUrl, `${source}/performances/lesson.mid`);
  assert.equal(body.failures.length, 0);
  const records = await (await fetch(base + '/api/records')).json();
  assert.equal(records.length, 1);
  assert.equal(records[0].versions[0].data.notes[0].soundingUntilMs, 1500);
});

test('直接演奏地址与内联 MIDI 字节都可接收', async context => {
  const { base } = await withService(context);
  const source = await withProvider(context);
  const byUrl = await (await postJson(base, {
    url: `${source}/performances/lesson.mid`, recording: 'remote-1',
  })).json();
  assert.equal(byUrl.recording, 'remote-1');
  assert.equal(byUrl.analysis.notes.length, 2);

  const inline = await (await postJson(base, {
    recording: 'inline-1', encoding: 'base64', midi: fixture.toString('base64'),
  })).json();
  assert.equal(inline.recording, 'inline-1');
  assert.equal(inline.rawSha256.length, 64);

  const invalid = await postJson(base, { encoding: 'base64', midi: '!!!not-base64!!!' });
  assert.equal(invalid.status, 400);
  const badEncoding = await postJson(base, { encoding: 'hex', midi: '00' });
  assert.equal(badEncoding.status, 400);
});

test('来源截断时按截断字节接收并记录不完整', async context => {
  const { base } = await withService(context);
  const source = await withProvider(context);
  await fetch(source + '/__control', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ truncated: true }),
  });
  const response = await postJson(base, { source });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.collected.length, 1);
  assert.equal(body.collected[0].analysis.complete, false);
});
