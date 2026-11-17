import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createIntake } from '../src/server.mjs';
import { createProvider } from '../provider/server.mjs';
const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const intake = await createIntake(directory); const provider = createProvider();
try {
  intake.listen(0, '127.0.0.1'); provider.listen(0, '127.0.0.1');
  await Promise.all([once(intake, 'listening'), once(provider, 'listening')]);
  const base = `http://127.0.0.1:${intake.address().port}`;
  const source = `http://127.0.0.1:${provider.address().port}`;
  const sample = JSON.parse(await readFile(new URL('../fixtures/manual.json', import.meta.url), 'utf8'));
  const project = JSON.parse(await readFile(new URL('../fixtures/project.json', import.meta.url), 'utf8'));

  // 人工收件仍然保留，与自动来源互不混淆。
  const accepted = await fetch(base + '/api/manual', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sample) });
  console.log(JSON.stringify({ 人工收件: await accepted.json() }));

  // 自动采集一：服务直接接收多轨 SMF 原始字节（先探查清单，再按相对链接取字节）。
  const listing = await (await fetch(source + project.probe)).json();
  const observed = await fetch(new URL(listing[0].href, source).href);
  const raw = Buffer.from(await observed.arrayBuffer());
  const direct = await fetch(base + '/api/collect', { method: 'POST', headers: { 'content-type': 'audio/midi', 'x-recording': 'lesson-1' }, body: raw });
  const directBody = await direct.json();
  console.log(JSON.stringify({
    自动直投: {
      status: direct.status, recording: directBody.identity.recording, complete: directBody.complete,
      noteCount: directBody.noteCount, anomalyCount: directBody.anomalyCount,
    },
  }));

  // 自动采集二：收件端按来源相对链接自行拉取，速度、踏板、叠键都在服务端解释。
  const pulled = await fetch(base + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceUrl: source }) });
  const pulledBody = await pulled.json();
  console.log(JSON.stringify({ 来源拉取: { status: pulled.status, count: pulledBody.count, 首份: pulledBody.collected[0].identity } }));

  // 截断情景：来源交付不完整文件，服务如实记录边界与异常，不伪装成完整演奏。
  await fetch(source + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ truncated: true }) });
  const broken = Buffer.from(await (await fetch(`${source}/performances/lesson.mid`)).arrayBuffer());
  const brokenReply = await fetch(base + '/api/collect', { method: 'POST', headers: { 'content-type': 'audio/midi', 'x-recording': 'lesson-1-truncated' }, body: broken });
  const brokenBody = await brokenReply.json();
  console.log(JSON.stringify({ 截断交付: { status: brokenReply.status, complete: brokenBody.complete, anomalyCount: brokenBody.anomalyCount, noteCount: brokenBody.noteCount } }));

  const records = await (await fetch(base + '/api/records')).json();
  console.log(JSON.stringify({ 已存记录: records.map(item => ({ source: item.source, identity: item.identity, versions: item.versions.length })) }));
} finally { intake.closeAllConnections(); provider.closeAllConnections(); await Promise.all([new Promise(resolve => intake.close(resolve)), new Promise(resolve => provider.close(resolve))]); await rm(directory, { recursive: true, force: true }); }
