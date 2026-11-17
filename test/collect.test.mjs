import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Archive } from '../src/archive.mjs';
import { receivePerformance, pullPerformances } from '../src/collect.mjs';
import { createIntake } from '../src/server.mjs';
import { createProvider } from '../provider/server.mjs';
import { smf, track, message } from './helpers/midi.mjs';

const lesson = await readFile(new URL('../fixtures/lesson.mid', import.meta.url));

async function freshArchive(context) {
  const directory = await mkdtemp(join(tmpdir(), 'collect-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return new Archive(directory).initialize();
}

test('自动采集同时归档原始字节与可解释结果，重复投递复用版本', async context => {
  const archive = await freshArchive(context);
  const receipt = await receivePerformance(archive, lesson, { recording: 'lesson-1' });
  assert.equal(receipt.version, 1);
  assert.equal(receipt.complete, true);
  assert.equal(receipt.noteCount, 2);
  const stored = (await archive.list())[0];
  assert.equal(stored.source, 'automatic');
  assert.deepEqual(stored.identity, { recording: 'lesson-1' });
  const raw = await archive.bytes(receipt.sha256);
  assert.deepEqual(Buffer.from(raw), lesson);
  assert.equal(stored.versions[0].data.notes.length, 2);
  assert.ok(stored.versions[0].data.events.length >= 10);
  assert.equal(stored.versions[0].data.rawSha256, receipt.sha256);
  const again = await receivePerformance(archive, lesson, { recording: 'lesson-1' });
  assert.equal(again.duplicate, true);
});

test('截断文件仍被接收并明确标注不完整，不伪装成完美演奏', async context => {
  const archive = await freshArchive(context);
  const truncated = lesson.subarray(0, lesson.length - 8);
  const receipt = await receivePerformance(archive, truncated, { recording: 'lesson-1-broken' });
  assert.equal(receipt.complete, false);
  assert.ok(receipt.anomalyCount >= 1);
  const [record] = await archive.list();
  assert.equal(record.versions[0].data.complete, false);
  assert.ok(record.versions[0].data.anomalies.some(item => item.code === 'truncated-track'));
});

test('SMPTE 与空请求体拒绝接收', async context => {
  const archive = await freshArchive(context);
  await assert.rejects(() => receivePerformance(archive, Buffer.alloc(0)), /空请求体/);
  const body = Buffer.alloc(6);
  body.writeUInt16BE(1, 0); body.writeUInt16BE(1, 2); body.writeUInt16BE(0x80c8, 4);
  await assert.rejects(() => receivePerformance(archive, Buffer.concat([Buffer.from('MThd'), Buffer.from([0, 0, 0, 6]), body])), /SMPTE/);
});

test('来源拉取按相对链接解释并逐份归档', async context => {
  const provider = createProvider();
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  context.after(async () => { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); });
  const source = `http://127.0.0.1:${provider.address().port}`;
  const archive = await freshArchive(context);
  const summary = await pullPerformances(archive, source);
  assert.equal(summary.count, 1);
  assert.equal(summary.collected[0].identity.recording, 'lesson-1');
  assert.equal(summary.collected[0].fetchedFrom, `${source}/performances/lesson.mid`);
  const records = await archive.list();
  assert.equal(records[0].source, 'automatic-pull');
});

test('HTTP 自动入口支持原始字节、JSON 封装与来源拉取三种投递', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'http-collect-'));
  const service = await createIntake(directory);
  service.listen(0, '127.0.0.1'); await once(service, 'listening');
  context.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${service.address().port}`;

  const direct = await fetch(base + '/api/collect', { method: 'POST', headers: { 'content-type': 'audio/midi', 'x-recording': 'lesson-1' }, body: lesson });
  assert.equal(direct.status, 201);
  const directBody = await direct.json();
  assert.equal(directBody.noteCount, 2);
  assert.equal(directBody.identity.recording, 'lesson-1');

  const wrapped = await fetch(base + '/api/collect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ recording: 'lesson-2', data: lesson.toString('base64') }),
  });
  assert.equal(wrapped.status, 201);
  assert.equal((await wrapped.json()).version, 1);

  const invalidJson = await fetch(base + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(invalidJson.status, 400);

  const badEnvelope = await fetch(base + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: 123 }) });
  assert.equal(badEnvelope.status, 422);

  const records = await (await fetch(base + '/api/records')).json();
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(item => item.source).sort(), ['automatic', 'automatic']);
});

test('HTTP 来源拉取模式打通真实来源服务', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'http-pull-'));
  const intake = await createIntake(directory);
  const provider = createProvider();
  intake.listen(0, '127.0.0.1'); provider.listen(0, '127.0.0.1');
  await Promise.all([once(intake, 'listening'), once(provider, 'listening')]);
  context.after(async () => {
    intake.closeAllConnections(); provider.closeAllConnections();
    await Promise.all([new Promise(resolve => intake.close(resolve)), new Promise(resolve => provider.close(resolve))]);
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${intake.address().port}`;
  const source = `http://127.0.0.1:${provider.address().port}`;
  const response = await fetch(base + '/api/collect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceUrl: source }),
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.count, 1);
  assert.equal(body.collected[0].complete, true);
});

test('自动与人工来源在同一归档中互不混淆', async context => {
  const archive = await freshArchive(context);
  const manual = JSON.parse(await readFile(new URL('../fixtures/manual.json', import.meta.url)));
  const { receiveManual } = await import('../src/intake.mjs');
  await receiveManual(archive, manual);
  await receivePerformance(archive, lesson, { recording: 'lesson-1' });
  const records = await archive.list();
  assert.deepEqual(records.map(item => item.source).sort(), ['automatic', 'manual']);
});

test('解析失败的字节返回 422 且错误信息保留原因', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'http-bad-'));
  const service = await createIntake(directory);
  service.listen(0, '127.0.0.1'); await once(service, 'listening');
  context.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${service.address().port}`;
  const response = await fetch(base + '/api/collect', { method: 'POST', headers: { 'content-type': 'audio/midi' }, body: Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) });
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /MThd/);

  const empty = await fetch(base + '/api/collect', { method: 'POST', headers: { 'content-type': 'audio/midi' }, body: Buffer.alloc(0) });
  assert.equal(empty.status, 422);
  assert.match((await empty.json()).error, /空请求体/);
});

test('超过大小上限的自动投递返回 413', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'http-large-'));
  const service = await createIntake(directory);
  service.listen(0, '127.0.0.1'); await once(service, 'listening');
  context.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${service.address().port}`;
  const response = await fetch(base + '/api/collect', { method: 'POST', headers: { 'content-type': 'audio/midi' }, body: Buffer.alloc(16 * 1024 * 1024 + 1) });
  assert.equal(response.status, 413);
});

test('同音高叠键与无匹配松键通过自动采集完整留痕', async context => {
  const archive = await freshArchive(context);
  const file = smf({
    tracks: [
      track([{ delta: 0, bytes: message.noteOn(0, 60, 90) }, { delta: 120, bytes: message.end() }]),
      track([{ delta: 60, bytes: message.noteOff(0, 70) }, { delta: 0, bytes: message.end() }]),
    ],
  });
  const receipt = await receivePerformance(archive, file, { recording: 'edge-cases' });
  const [record] = await archive.list();
  const data = record.versions[0].data;
  assert.equal(data.notes[0].endReason, 'track-end');
  assert.ok(data.anomalies.some(item => item.code === 'orphan-note-off'));
  assert.equal(receipt.anomalyCount, data.anomalies.length);
});
