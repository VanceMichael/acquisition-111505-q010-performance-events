import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createProvider } from '../provider/server.mjs';
async function withSource(context) {
  const service = createProvider(); service.listen(0, '127.0.0.1'); await once(service, 'listening');
  context.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); });
  const base = `http://127.0.0.1:${service.address().port}`;
  const control = value => fetch(base + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const post = (path, value) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  return { base, control, post };
}

test('演奏包含三轨、速度变化和共享通道踏板', async context => {
  const { base } = await withSource(context); const raw = Buffer.from(await (await fetch(base + '/performances/lesson.mid')).arrayBuffer());
  assert.equal(raw.subarray(0, 4).toString(), 'MThd'); assert.equal(raw.readUInt16BE(10), 3); assert.equal(raw.readUInt16BE(12), 480);
  assert.equal(raw.indexOf(Buffer.from([0xb0, 0x40, 0x7f])) > 0, true); assert.equal(raw.indexOf(Buffer.from([0xff, 0x51])) > 0, true);
});
test('截断交付保留原轨道长度而不是伪造完整文件', async context => {
  const { base, control } = await withSource(context); const first = Buffer.from(await (await fetch(base + '/performances/lesson.mid')).arrayBuffer());
  await control({ truncated: true }); const second = Buffer.from(await (await fetch(base + '/performances/lesson.mid')).arrayBuffer()); assert.equal(first.length - second.length, 5);
});
