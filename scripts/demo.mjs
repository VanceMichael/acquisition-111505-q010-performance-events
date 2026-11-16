import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createIntake } from '../src/server.mjs';
import { createProvider } from '../provider/server.mjs';

const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const intake = await createIntake(directory);
const provider = createProvider();
try {
  intake.listen(0, '127.0.0.1');
  provider.listen(0, '127.0.0.1');
  await Promise.all([once(intake, 'listening'), once(provider, 'listening')]);
  const base = `http://127.0.0.1:${intake.address().port}`;
  const source = `http://127.0.0.1:${provider.address().port}`;
  const sample = JSON.parse(await readFile(new URL('../fixtures/manual.json', import.meta.url), 'utf8'));
  const project = JSON.parse(await readFile(new URL('../fixtures/project.json', import.meta.url), 'utf8'));

  const observed = await fetch(source + project.probe);
  const listing = Buffer.from(await observed.arrayBuffer());
  console.log(JSON.stringify({ 来源状态: observed.status, 来源列表字节: listing.length, 来源类型: observed.headers.get('content-type') }));

  const accepted = await fetch(base + '/api/manual', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sample),
  });
  console.log(JSON.stringify({ 人工收件: await accepted.json() }));

  const collected = await fetch(base + '/api/collect', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source }),
  });
  const result = await collected.json();
  console.log(JSON.stringify({ 自动收件状态: collected.status }));
  for (const item of result.collected) console.log(JSON.stringify({
    演奏: item.recording,
    版本: item.version,
    完整文件: item.complete,
    全部区间完整: item.performanceComplete,
    无歧义: item.performanceCertain,
    音符数: item.counts.notes,
    未匹配松键: item.counts.unmatchedNoteOffs,
    歧义: item.counts.ambiguities,
  }));
  console.log(JSON.stringify({ 来源失败: result.failures }));

  const notes = await (await fetch(base + '/api/notes?recording=lesson-1&pitch=60')).json();
  console.log(JSON.stringify({ 检索音符: notes.count, 细节: notes.notes.map(note => ({
    音符: note.noteId, 按下: note.pressedMs, 松键: note.releasedMs,
    发声至: note.soundingUntilMs, 结束原因: note.endReason,
    松键已知: note.releaseKnown, 发声边界已知: note.soundingEndKnown,
  })) }));

  const records = await (await fetch(base + '/api/records')).json();
  console.log(JSON.stringify({ 归档来源: records.map(record => record.source) }));

  await fetch(source + '/__control', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ truncated: true }),
  });
  const truncated = await fetch(base + '/api/collect', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source }),
  });
  const truncatedResult = await truncated.json();
  const item = truncatedResult.collected[0];
  console.log(JSON.stringify({
    截断收件状态: truncated.status,
    完整文件: item.complete,
    全部区间完整: item.performanceComplete,
    未决边界: item.analysis.counts.openNotes,
    诊断: item.analysis.diagnostics.map(entry => entry.code),
  }));
} finally {
  intake.closeAllConnections();
  provider.closeAllConnections();
  await Promise.all([
    new Promise(resolve => intake.close(resolve)),
    new Promise(resolve => provider.close(resolve)),
  ]);
  await rm(directory, { recursive: true, force: true });
}
