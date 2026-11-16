import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { Archive } from './archive.mjs';
import { collect, receiveManual, receivePerformance, summarize } from './intake.mjs';
import { MidiError } from './midi.mjs';

const JSON_LIMIT = 1048576;
const MIDI_LIMIT = 8 * 1024 * 1024;

async function readBody(incoming, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of incoming) {
    length += chunk.length;
    if (length > limit) return { error: '超过单份资料上限', status: 413 };
    chunks.push(chunk);
  }
  return { bytes: Buffer.concat(chunks) };
}

function isJson(contentType) {
  return String(contentType ?? '').includes('application/json');
}

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

export async function createIntake(directory, options = {}) {
  const archive = await new Archive(directory).initialize();
  const sourceUrl = options.sourceUrl ?? process.env.SOURCE_URL ?? null;
  return createServer(async (incoming, outgoing) => {
    const reply = (status, body) => {
      outgoing.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      outgoing.end(JSON.stringify(body));
    };
    try {
      const requestUrl = new URL(incoming.url, 'http://localhost');
      if (incoming.method === 'GET' && requestUrl.pathname === '/health') {
        return reply(200, { status: 'ok', acquisition: 'manual+automatic', formats: ['midi'] });
      }
      if (incoming.method === 'GET' && requestUrl.pathname === '/api/records') {
        return reply(200, await archive.list());
      }
      if (incoming.method === 'GET' && requestUrl.pathname.startsWith('/api/records/')) {
        const segments = requestUrl.pathname.slice('/api/records/'.length).split('/');
        const key = decodeURIComponent(segments[0] ?? '');
        if (!/^[0-9a-f]{64}$/.test(key)) return reply(400, { error: '收件标识格式无效' });
        if (segments.length === 1) {
          const record = await archive.record(key);
          if (!record) return reply(404, { error: '收件不存在' });
          return reply(200, record);
        }
        if (segments.length === 2 && segments[1] === 'raw') {
          const found = await archive.version(key);
          if (!found) return reply(404, { error: '收件不存在' });
          outgoing.writeHead(200, { 'content-type': 'audio/midi' });
          outgoing.end(found.bytes);
          return undefined;
        }
        if (segments.length === 2) {
          const version = Number(decodeURIComponent(segments[1]));
          if (!Number.isInteger(version) || version < 1) return reply(400, { error: '版本号无效' });
          const found = await archive.version(key, version);
          if (!found) return reply(404, { error: '版本不存在' });
          return reply(200, {
            receipt: found.record.receipt,
            source: found.record.source,
            identity: found.record.identity,
            version: found.entry.version,
            sha256: found.entry.sha256,
            receivedAt: found.entry.receivedAt,
            data: found.entry.data,
          });
        }
        return reply(404, { error: '路径不存在' });
      }
      if (incoming.method === 'GET' && requestUrl.pathname === '/api/notes') {
        const result = await searchNotes(archive, requestUrl.searchParams);
        return reply(result.error ? 400 : 200, result);
      }
      if (incoming.method === 'POST' && requestUrl.pathname === '/api/collect') {
        const body = await readBody(incoming, MIDI_LIMIT);
        if (body.error) return reply(body.status, { error: body.error });
        const query = Object.fromEntries(requestUrl.searchParams);
        if (isJson(incoming.headers['content-type'])) {
          if (body.bytes.length > JSON_LIMIT) return reply(413, { error: '单份自动收件指令过大' });
          let payload;
          try { payload = body.bytes.length === 0 ? {} : JSON.parse(body.bytes.toString('utf8')); }
          catch { return reply(400, { error: 'JSON 无效' }); }
          const midi = payload.midi ?? payload.data ?? payload.bytes;
          if (typeof midi === 'string' && midi !== '') {
            const encoding = payload.encoding ?? 'base64';
            if (encoding !== 'base64' && encoding !== 'utf8') {
              return reply(400, { error: 'encoding 仅支持 base64 或 utf8' });
            }
            if (encoding === 'base64'
              && (midi.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(midi))) {
              return reply(400, { error: 'MIDI base64 内容无效' });
            }
            const bytes = Buffer.from(midi, encoding);
            try { return reply(201, await acceptBytes(archive, bytes, payload.recording)); }
            catch (error) { return midiReply(reply, error); }
          }
          const source = payload.source ?? payload.sourceUrl ?? query.source ?? sourceUrl;
          const url = payload.url ?? payload.href ?? query.url;
          if (!source && !url) {
            return reply(400, { error: '需要提供 MIDI 字节、演奏地址 url 或来源地址 source' });
          }
          try {
            const result = await collect(archive, {
              source: source ?? undefined,
              url: url ?? undefined,
              recording: payload.recording,
              probe: payload.probe,
            });
            if (result.collected) {
              return reply(result.failures.length > 0 ? 207 : 201, summarize(result));
            }
            return reply(201, acceptBytesResult(result));
          } catch (error) {
            if (error instanceof MidiError) return midiReply(reply, error);
            return reply(502, { error: error.message });
          }
        }
        if (body.bytes.length === 0) {
          if (!sourceUrl) return reply(400, { error: '空请求，需提供 MIDI 字节或 JSON 指令' });
          try {
            const result = await collect(archive, { source: sourceUrl });
            return reply(result.failures.length > 0 ? 207 : 201, summarize(result));
          } catch (error) { return reply(502, { error: error.message }); }
        }
        const recording = incoming.headers['x-recording']
          ? safeDecode(String(incoming.headers['x-recording']))
          : query.recording;
        try {
          return reply(201, await acceptBytes(archive, body.bytes, recording));
        } catch (error) { return midiReply(reply, error); }
      }
      if (incoming.method === 'POST' && requestUrl.pathname === '/api/manual') {
        const body = await readBody(incoming, JSON_LIMIT);
        if (body.error) return reply(body.status, { error: '单份人工收件过大' });
        let payload;
        try { payload = JSON.parse(body.bytes.toString('utf8')); }
        catch { return reply(400, { error: 'JSON 无效' }); }
        try { return reply(201, await receiveManual(archive, payload)); }
        catch (error) { return reply(422, { error: error.message }); }
      }
      return reply(404, { error: '路径不存在' });
    } catch (error) { return reply(500, { error: error.message }); }
  });
}

function midiReply(reply, error) {
  if (error instanceof MidiError) {
    return reply(error.code === 'NOT_MIDI' ? 415 : 422, {
      error: error.message, code: error.code, details: error.details,
    });
  }
  return reply(422, { error: error.message });
}

function numberParameter(search, name) {
  if (!search.has(name)) return null;
  const value = Number(search.get(name));
  return Number.isFinite(value) ? value : NaN;
}

export async function searchNotes(archive, search) {
  const filters = {
    recording: search.get('recording'),
    channel: numberParameter(search, 'channel'),
    pitch: numberParameter(search, 'pitch'),
    track: numberParameter(search, 'track'),
    from: numberParameter(search, 'from'),
    to: numberParameter(search, 'to'),
    complete: search.has('complete') ? search.get('complete') !== 'false' : null,
  };
  for (const key of ['channel', 'pitch', 'track', 'from', 'to']) {
    if (Number.isNaN(filters[key])) return { error: `${key} 应为数字` };
  }
  const records = await archive.list();
  const matches = [];
  for (const record of records) {
    if (filters.recording && record.identity?.recording !== filters.recording) continue;
    const entry = record.versions[record.versions.length - 1];
    if (!entry || entry.data?.kind !== 'performance') continue;
    for (const note of entry.data.notes) {
      if (filters.channel !== null && note.channel !== filters.channel) continue;
      if (filters.pitch !== null && note.pitch !== filters.pitch) continue;
      if (filters.track !== null && note.track !== filters.track) continue;
      if (filters.from !== null && note.pressedMs < filters.from) continue;
      if (filters.to !== null && note.pressedMs > filters.to) continue;
      if (filters.complete !== null && note.complete !== filters.complete) continue;
      matches.push({
        receipt: record.receipt,
        version: entry.version,
        recording: entry.data.recording,
        noteId: note.id,
        channel: note.channel,
        track: note.track,
        pitch: note.pitch,
        velocity: note.velocity,
        pressed: note.pressed,
        pressedMs: note.pressedMs,
        released: note.released,
        releasedMs: note.releasedMs,
        soundingUntil: note.soundingUntil,
        soundingUntilMs: note.soundingUntilMs,
        endReason: note.endReason,
        releaseKnown: note.releaseKnown,
        soundingEndKnown: note.soundingEndKnown,
        complete: note.complete,
        program: note.program,
        sustainAtPress: note.sustainAtPress,
      });
    }
  }
  matches.sort((left, right) => left.pressedMs - right.pressedMs
    || left.recording.localeCompare(right.recording)
    || left.noteId.localeCompare(right.noteId));
  return { filters, count: matches.length, notes: matches };
}

async function acceptBytes(archive, bytes, recording) {
  return acceptBytesResult(await receivePerformance(archive, bytes, { recording }));
}

function acceptBytesResult(result) {
  const analysis = result.analysis;
  return {
    receipt: result.receipt,
    version: result.version,
    duplicate: result.duplicate,
    sha256: result.sha256,
    rawSha256: result.rawSha256,
    identity: result.identity,
    recording: result.recording,
    sourceUrl: result.sourceUrl,
    complete: analysis.complete,
    performanceComplete: analysis.performanceComplete,
    performanceCertain: analysis.performanceCertain,
    counts: analysis.counts,
    diagnostics: analysis.diagnostics,
    analysis,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = await createIntake(process.env.ARCHIVE_DIR || '.local/archive');
  service.listen(Number(process.env.PORT || 3200), '0.0.0.0', () => console.log('收件服务已就绪'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => service.close(() => process.exit(0)));
}
