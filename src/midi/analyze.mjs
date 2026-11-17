// 汇总解析、时间换算与通道解释，输出同时保留原始事件顺序和可解释音符区间的接收结果。
import { parseSmf } from './parse.mjs';
import { createTiming } from './timing.mjs';
import { interpret } from './interpret.mjs';
import { digest } from '../archive.mjs';

export function analyzePerformance(buffer) {
  const parsed = parseSmf(buffer);
  if (!parsed.division) {
    return {
      complete: false,
      accepted: false,
      header: parsed.header,
      division: null,
      events: [],
      notes: [],
      channels: {},
      tempoMap: [],
      boundaries: { fileEnd: null, truncatedTracks: [] },
      anomalies: parsed.anomalies,
      anomalyCount: parsed.anomalies.length,
      rawSha256: digest(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)),
    };
  }
  const timing = createTiming(parsed.events, { ppqn: parsed.division.ppqn, defaultTempo: parsed.defaultTempo });
  const explained = interpret(timing, parsed);
  const anomalies = [...parsed.anomalies, ...explained.anomalies];
  const tracks = parsed.tracks.map(track => ({
    index: track.index,
    declaredLength: track.declaredLength,
    finalized: track.finalized,
    truncated: track.truncated,
    eventCount: track.events.length,
  }));
  return {
    accepted: true,
    complete: parsed.complete,
    header: parsed.header,
    division: parsed.division,
    tracks,
    // 原始事件顺序：全局 tick 顺序，同 tick 保留轨道/轨内序号证据。
    events: timing.timeline,
    tempoMap: timing.tempoMap,
    notes: explained.notes,
    channels: explained.channels,
    boundaries: explained.boundaries,
    anomalies,
    anomalyCount: anomalies.length,
    rawSha256: digest(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)),
  };
}
