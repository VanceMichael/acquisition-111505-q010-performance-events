import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { digest } from './archive.mjs';
import { parseMidi } from './midi.mjs';
import { decodeJson, request } from './transport.mjs';

const configuration = JSON.parse(await readFile(new URL('../fixtures/project.json', import.meta.url), 'utf8'));

export function manualRecord(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('人工收件应是对象');
  for (const field of configuration.identityFields) {
    if (payload[field] === undefined || payload[field] === null || payload[field] === '') throw new Error(`缺少业务身份 ${field}`);
  }
  const identity = Object.fromEntries(configuration.identityFields.map(field => [field, payload[field]]));
  return { identity, data: structuredClone(payload) };
}
export async function receiveManual(archive, payload) {
  const parsed = manualRecord(payload);
  const raw = Buffer.from(JSON.stringify(payload));
  const receipt = await archive.accept('manual', parsed.identity, parsed.data, raw);
  return { ...receipt, identity: parsed.identity, rawSha256: digest(raw) };
}

function normalizeRecording(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function midiTrackRecording(parsed) {
  const named = parsed.tracks.find(track => typeof track.name === 'string' && track.name.trim() !== '');
  return named ? normalizeRecording(named.name) : null;
}

function performanceData(recording, parsed) {
  return {
    kind: 'performance',
    recording,
    format: parsed.format,
    trackCount: parsed.trackCount,
    parsedTrackCount: parsed.parsedTrackCount,
    division: parsed.division,
    ticksPerQuarter: parsed.ticksPerQuarter,
    timing: parsed.timing,
    complete: parsed.complete,
    truncated: parsed.truncated,
    durationTicks: parsed.durationTicks,
    durationMs: parsed.durationMs,
    durationBoundary: parsed.durationBoundary,
    tempoMap: parsed.tempoMap,
    ordering: parsed.ordering,
    tracks: parsed.tracks,
    channels: parsed.channels,
    notes: parsed.notes,
    events: parsed.events,
    rawEvents: parsed.rawEvents,
    unmatchedNoteOffs: parsed.unmatchedNoteOffs,
    openNotes: parsed.openNotes,
    ambiguities: parsed.ambiguities,
    diagnostics: parsed.diagnostics,
    performanceComplete: parsed.performanceComplete,
    performanceCertain: parsed.performanceCertain,
    counts: parsed.counts,
    byteLength: parsed.byteLength,
  };
}

export async function receivePerformance(archive, input, options = {}) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const parsed = parseMidi(bytes);
  const fallback = `upload-${digest(bytes).slice(0, 12)}`;
  const recording = normalizeRecording(options.recording)
    ?? midiTrackRecording(parsed)
    ?? fallback;
  const data = performanceData(recording, parsed);
  const receipt = await archive.accept('automatic', { recording }, data, bytes);
  return {
    ...receipt,
    identity: { recording },
    recording,
    sourceUrl: options.sourceUrl,
    rawSha256: digest(bytes),
    analysis: parsed,
  };
}

function ensureHttpUrl(value, label) {
  let url;
  try { url = value instanceof URL ? new URL(value.href) : new URL(String(value)); }
  catch { throw new Error(`${label}不是有效 URL`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${label}只支持 http/https`);
  return url;
}

function listingItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.performances)) return payload.performances;
  if (payload && Array.isArray(payload.recordings)) return payload.recordings;
  if (payload && Array.isArray(payload.items)) return payload.items;
  return null;
}

function itemLink(item) {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return null;
  return item.href ?? item.url ?? item.path ?? item.link ?? null;
}

function itemRecording(item, link, filter) {
  if (item && typeof item === 'object') {
    const named = normalizeRecording(item.recording ?? item.id ?? item.name);
    if (named) return named;
  }
  if (filter) return filter;
  if (typeof link === 'string') {
    const name = basename(new URL(link, 'http://placeholder').pathname);
    return normalizeRecording(name.replace(/\.midi?$/i, '')) ?? null;
  }
  return null;
}

async function fetchMidi(url, { limit = 8 * 1024 * 1024 } = {}) {
  const reply = await request(url);
  if (reply.status < 200 || reply.status > 299) throw new Error(`来源返回 ${reply.status}`);
  if (reply.bytes.length > limit) throw new Error(`演奏资料超过 ${limit} 字节上限`);
  return reply;
}

export async function collectUrl(archive, url, options = {}) {
  const target = ensureHttpUrl(url, '演奏地址');
  const reply = await fetchMidi(target, options);
  const type = String(reply.headers['content-type'] ?? '');
  const raw = reply.bytes;
  if (type.includes('json')) {
    let payload;
    try { payload = decodeJson(reply); } catch { throw new Error('来源演奏列表不是有效 JSON'); }
    return collectListing(archive, payload, target, options);
  }
  return receivePerformance(archive, raw, {
    recording: options.recording,
    sourceUrl: target.href,
  });
}

export async function collectListing(archive, payload, base, options = {}) {
  const items = listingItems(payload);
  if (!items) throw new Error('来源演奏列表结构无法识别');
  const collected = [];
  const failures = [];
  const filter = normalizeRecording(options.recording);
  for (const item of items) {
    const link = itemLink(item);
    if (typeof link !== 'string' || link === '') {
      failures.push({ item, error: '列表项缺少链接' });
      continue;
    }
    const recording = itemRecording(item, link, filter);
    if (filter && recording !== filter) continue;
    let resolved;
    try { resolved = new URL(link, base); } catch { failures.push({ href: link, error: '演奏链接无法解释' }); continue; }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      failures.push({ href: link, error: '演奏链接只支持 http/https' });
      continue;
    }
    try {
      const reply = await fetchMidi(resolved, options);
      const result = await receivePerformance(archive, reply.bytes, {
        recording: recording ?? undefined,
        sourceUrl: resolved.href,
      });
      collected.push({ ...result, sourceUrl: resolved.href });
    } catch (error) {
      failures.push({ href: resolved.href, recording, error: error.message });
    }
  }
  if (items.length === 0) throw new Error('来源列出空列表，没有可接收的演奏');
  if (collected.length === 0 && failures.length === 0) throw new Error('来源没有可接收的演奏');
  return { source: base.href, collected, failures };
}

export async function collectFromSource(archive, source, options = {}) {
  const base = ensureHttpUrl(source, '来源地址');
  const probe = options.probe ?? configuration.probe ?? '/performances';
  const listingUrl = new URL(probe, base);
  const reply = await fetchMidi(listingUrl, options);
  let payload;
  try { payload = decodeJson(reply); } catch { throw new Error('来源演奏列表不是有效 JSON'); }
  return collectListing(archive, payload, listingUrl, options);
}

export async function collect(archive, { source, url, recording, probe } = {}) {
  if (url) return collectUrl(archive, url, { recording, probe });
  if (source) return collectFromSource(archive, source, { recording, probe });
  throw new Error('需要来源地址或演奏地址');
}

export function summarize(result) {
  if (!result.collected) return result;
  return {
    source: result.source,
    collected: result.collected.map(item => ({
      recording: item.recording,
      receipt: item.receipt,
      version: item.version,
      duplicate: item.duplicate,
      sha256: item.sha256,
      rawSha256: item.rawSha256,
      sourceUrl: item.sourceUrl,
      complete: item.analysis.complete,
      performanceComplete: item.analysis.performanceComplete,
      performanceCertain: item.analysis.performanceCertain,
      counts: item.analysis.counts,
      diagnostics: item.analysis.diagnostics,
      analysis: item.analysis,
    })),
    failures: result.failures,
  };
}
