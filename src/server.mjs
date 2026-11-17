import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { Archive } from './archive.mjs';
import { receiveManual } from './intake.mjs';
import { receivePerformance, pullPerformances } from './collect.mjs';

const MAX_AUTO_BYTES = 16 * 1024 * 1024;

async function readBody(incoming, reply, limit) {
  const chunks = []; let length = 0;
  for await (const chunk of incoming) {
    length += chunk.length;
    if (length > limit) { reply(413, { error: '单份收件过大' }); return null; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function createIntake(directory) {
  const archive = await new Archive(directory).initialize();
  return createServer(async (incoming, outgoing) => {
    const reply = (status, body) => { outgoing.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); outgoing.end(JSON.stringify(body)); };
    try {
      if (incoming.method === 'GET' && incoming.url === '/health') return reply(200, { status: 'ok', acquisition: 'manual+automatic' });
      if (incoming.method === 'GET' && incoming.url === '/api/records') return reply(200, await archive.list());
      if (incoming.method === 'POST' && incoming.url === '/api/manual') {
        const body = await readBody(incoming, reply, 1048576); if (body === null) return;
        let payload; try { payload = JSON.parse(body.toString('utf8')); } catch { return reply(400, { error: 'JSON 无效' }); }
        try { return reply(201, await receiveManual(archive, payload)); } catch (error) { return reply(422, { error: error.message }); }
      }
      if (incoming.method === 'POST' && incoming.url === '/api/collect') {
        const body = await readBody(incoming, reply, MAX_AUTO_BYTES); if (body === null) return;
        const contentType = incoming.headers['content-type'] ?? '';
        try {
          if (contentType.includes('application/json')) {
            let envelope; try { envelope = JSON.parse(body.toString('utf8')); } catch { return reply(400, { error: 'JSON 无效' }); }
            if (envelope && typeof envelope === 'object' && envelope.sourceUrl !== undefined) {
              if (typeof envelope.sourceUrl !== 'string' || envelope.sourceUrl === '') throw new Error('来源拉取需要字符串 sourceUrl');
              return reply(201, await pullPerformances(archive, envelope.sourceUrl, envelope.probe ? { probe: envelope.probe } : {}));
            }
            if (!envelope || typeof envelope !== 'object' || typeof envelope.data !== 'string') throw new Error('封装采集需要 Base64 字符串字段 data');
            const raw = Buffer.from(envelope.data, 'base64');
            if (raw.length === 0) throw new Error('Base64 解码后为空，无法按演奏资料接收');
            return reply(201, await receivePerformance(archive, raw, { recording: envelope.recording ?? null }));
          }
          return reply(201, await receivePerformance(archive, body, { recording: incoming.headers['x-recording'] ?? null }));
        } catch (error) { return reply(422, { error: error.message }); }
      }
      return reply(404, { error: '路径不存在' });
    } catch (error) { return reply(500, { error: error.message }); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = await createIntake(process.env.ARCHIVE_DIR || '.local/archive');
  service.listen(Number(process.env.PORT || 3200), '0.0.0.0', () => console.log('收件服务已就绪'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => service.close(() => process.exit(0)));
}
