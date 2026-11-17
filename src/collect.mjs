// 自动采集：Node.js 服务直接接收多轨演奏资料，不再依赖人工摘要。
// 既支持直接投递原始 SMF 字节，也支持按合作来源相对链接拉取；原始字节与解释结果同时归档。
import { readFile } from 'node:fs/promises';
import { analyzePerformance } from './midi/analyze.mjs';
import { request } from './transport.mjs';
import { digest } from './archive.mjs';

function normalizeRecording(recording) {
  if (recording === undefined || recording === null || recording === '') return null;
  return String(recording);
}

export async function receivePerformance(archive, raw, { source = 'automatic', recording = null, fetchedFrom = null } = {}) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (bytes.length === 0) throw new Error('自动采集需要原始演奏字节，不接受空请求体');
  const result = analyzePerformance(bytes);
  if (!result.accepted) {
    const fatal = result.anomalies.find(item => item.code === 'bad-signature' || item.code === 'unsupported-format' || item.code === 'unsupported-division' || item.code === 'truncated-header');
    throw new Error(fatal ? fatal.message : '演奏资料无法按 SMF 子集解释');
  }
  const identity = { recording: normalizeRecording(recording) };
  const data = {
    recording: identity.recording,
    source,
    fetchedFrom,
    complete: result.complete,
    header: result.header,
    division: result.division,
    tracks: result.tracks,
    tempoMap: result.tempoMap,
    events: result.events,
    notes: result.notes,
    channels: result.channels,
    boundaries: result.boundaries,
    anomalies: result.anomalies,
    anomalyCount: result.anomalyCount,
    rawSha256: result.rawSha256,
  };
  const receipt = await archive.accept(source, identity, data, bytes);
  return { ...receipt, identity, fetchedFrom: fetchedFrom ?? null, rawSha256: digest(bytes), complete: result.complete, anomalyCount: result.anomalyCount, noteCount: result.notes.length };
}

// 按来源约定探查：先取 /performances 清单，再把相对链接以实际来源地址解释后逐份拉取。
export async function pullPerformances(archive, baseUrl, options = {}) {
  const project = JSON.parse(await readFile(new URL('../fixtures/project.json', import.meta.url), 'utf8'));
  const probe = options.probe ?? project.probe;
  const listing = await request(new URL(probe, baseUrl).href);
  if (listing.status !== 200) throw new Error(`来源探查返回 ${listing.status}`);
  const items = JSON.parse(listing.bytes.toString('utf8'));
  if (!Array.isArray(items)) throw new Error('来源清单应为数组');
  const collected = [];
  for (const item of items) {
    if (!item || typeof item.href !== 'string') throw new Error('来源清单条目缺少相对链接 href');
    const href = new URL(item.href, baseUrl).href;
    const response = await request(href);
    if (response.status !== 200) throw new Error(`来源演奏返回 ${response.status}`);
    const receipt = await receivePerformance(archive, response.bytes, {
      source: 'automatic-pull',
      recording: normalizeRecording(item.recording),
      fetchedFrom: href,
    });
    collected.push({ recording: receipt.identity.recording, href, ...receipt });
  }
  return { source: baseUrl, probe: new URL(probe, baseUrl).href, count: collected.length, collected };
}
