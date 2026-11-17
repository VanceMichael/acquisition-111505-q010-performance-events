// Standard MIDI File（format 0/1 子集）字节解析。
// 只依据 docs/source-contract.md 列出的事件类型解释；无法解释的字节保留为异常与原始证据，不臆造内容。

const HEADER_LENGTH = 14;
const DEFAULT_TEMPO_US_PER_QUARTER = 500000;

function readUint32(bytes, offset) {
  return (bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}

// VLQ 解码：返回 { value, size }；字节不足或超过 4 字节规范上限时标记 truncated。
function readVlq(bytes, offset) {
  let value = 0;
  let size = 0;
  let current;
  do {
    if (offset + size >= bytes.length) return { value, size, truncated: true };
    current = bytes[offset + size];
    value = (value << 7) | (current & 0x7f);
    size += 1;
    if (size > 4) return { value, size, truncated: true };
  } while (current & 0x80);
  return { value, size, truncated: false };
}

function classifyMessage(statusByte, dataBytes) {
  const kind = statusByte & 0xf0;
  const channel = statusByte & 0x0f;
  const [data1 = null, data2 = null] = dataBytes;
  switch (kind) {
    case 0x80:
      return { type: 'note-off', channel, pitch: data1, velocity: data2 };
    case 0x90:
      // 力度 0 的 note-on 等同于松键，但保留来源写法，解释阶段单独标注。
      if (data2 === 0) return { type: 'note-on-zero', channel, pitch: data1, velocity: data2 };
      return { type: 'note-on', channel, pitch: data1, velocity: data2 };
    case 0xa0:
      return { type: 'poly-aftertouch', channel, pitch: data1, pressure: data2 };
    case 0xb0:
      return { type: 'control-change', channel, controller: data1, value: data2 };
    case 0xc0:
      return { type: 'program-change', channel, program: data1 };
    case 0xd0:
      return { type: 'channel-aftertouch', channel, pressure: data1 };
    case 0xe0:
      return { type: 'pitch-bend', channel, value: ((data2 ?? 0) << 7) | (data1 ?? 0) };
    default:
      return { type: 'unknown-channel', channel };
  }
}

function parseTrack(trackIndex, bytes, start, length, anomalies) {
  const end = start + length;
  const events = [];
  let cursor = start;
  let tick = 0;
  let runningStatus = null;
  const report = (code, message, extra = {}) => anomalies.push({ code, track: trackIndex, tick, ...extra, message });

  while (cursor < end) {
    const delta = readVlq(bytes, cursor);
    cursor += delta.size;
    if (delta.truncated) {
      report('truncated-delta', '轨道在 delta-time VLQ 处截断，后续字节无法解释');
      return { events, finalized: false, consumed: end };
    }
    tick += delta.value;

    if (cursor >= end) {
      report('truncated-event', 'delta 之后缺少事件状态字节');
      return { events, finalized: false, consumed: end };
    }
    let statusByte = bytes[cursor];
    let rawStart = cursor;
    if (statusByte < 0x80) {
      // running status 仅在同一轨道内延续（SMF 规范），新轨道从空状态开始。
      if (runningStatus === null) {
        report('missing-status', '事件缺少状态字节且没有可沿用的 running status');
        return { events, finalized: false, consumed: end };
      }
      statusByte = runningStatus;
    } else {
      cursor += 1;
      if (statusByte < 0xf0) runningStatus = statusByte;
    }

    if (statusByte === 0xff) {
      if (cursor >= end) { report('truncated-meta', 'meta 事件缺少类型字节'); return { events, finalized: false, consumed: end }; }
      const metaType = bytes[cursor]; cursor += 1;
      const metaLength = readVlq(bytes, cursor); cursor += metaLength.size;
      if (metaLength.truncated) { report('truncated-meta', 'meta 事件长度 VLQ 不完整'); return { events, finalized: false, consumed: end }; }
      if (cursor + metaLength.value > end) {
        report('truncated-meta', 'meta 事件数据超出轨道边界', { metaType, declaredLength: metaLength.value });
        return { events, finalized: false, consumed: end };
      }
      const data = bytes.subarray(cursor, cursor + metaLength.value);
      const raw = bytes.subarray(rawStart, cursor + metaLength.value);
      cursor += metaLength.value;
      const event = { track: trackIndex, tick, order: events.length, status: 0xff, metaType, raw: Array.from(raw) };
      if (metaType === 0x2f) {
        event.type = 'end-of-track';
        events.push(event);
        return { events, finalized: true, consumed: end };
      }
      if (metaType === 0x51) {
        if (data.length !== 3) report('invalid-tempo', '速度 meta 数据长度应为 3 字节', { metaLength: data.length });
        else event.tempo = (data[0] << 16) | (data[1] << 8) | data[2];
      }
      event.type = event.type ?? 'meta';
      events.push(event);
      continue;
    }

    if (statusByte === 0xf0 || statusByte === 0xf7) {
      const sysexLength = readVlq(bytes, cursor); cursor += sysexLength.size;
      if (sysexLength.truncated || cursor + sysexLength.value > end) {
        report('truncated-sysex', '系统专用事件超出轨道边界');
        return { events, finalized: false, consumed: end };
      }
      const raw = bytes.subarray(rawStart, cursor + sysexLength.value);
      cursor += sysexLength.value;
      events.push({ track: trackIndex, tick, order: events.length, type: 'sysex', status: statusByte, raw: Array.from(raw) });
      continue;
    }

    if (statusByte === 0xf1 || statusByte === 0xf3) {
      if (cursor + 1 > end) { report('truncated-system', '系统公用事件数据不足'); return { events, finalized: false, consumed: end }; }
      const raw = bytes.subarray(rawStart, cursor + 1);
      cursor += 1;
      events.push({ track: trackIndex, tick, order: events.length, type: 'system-common', status: statusByte, raw: Array.from(raw) });
      continue;
    }
    if (statusByte === 0xf2) {
      if (cursor + 2 > end) { report('truncated-system', '系统公用事件数据不足'); return { events, finalized: false, consumed: end }; }
      const raw = bytes.subarray(rawStart, cursor + 2);
      cursor += 2;
      events.push({ track: trackIndex, tick, order: events.length, type: 'system-common', status: statusByte, raw: Array.from(raw) });
      continue;
    }
    if (statusByte >= 0xf1 && statusByte <= 0xfe) {
      const raw = bytes.subarray(rawStart, cursor);
      events.push({ track: trackIndex, tick, order: events.length, type: statusByte === 0xf6 ? 'system-common' : 'system-realtime', status: statusByte, raw: Array.from(raw) });
      continue;
    }
    if ((statusByte & 0x80) === 0) {
      report('invalid-status', `无法解释的状态字节 0x${statusByte.toString(16)}`);
      return { events, finalized: false, consumed: end };
    }

    const dataSize = ((statusByte & 0xe0) === 0xc0) ? 1 : 2;
    if (cursor + dataSize > end) {
      report('truncated-channel', '通道事件数据字节不足', { status: statusByte });
      return { events, finalized: false, consumed: end };
    }
    const dataBytes = Array.from(bytes.subarray(cursor, cursor + dataSize));
    const raw = bytes.subarray(rawStart, cursor + dataSize);
    cursor += dataSize;
    events.push({ track: trackIndex, tick, order: events.length, status: statusByte, raw: Array.from(raw), ...classifyMessage(statusByte, dataBytes) });
  }

  report('missing-end-of-track', '轨道数据耗尽但未见 end-of-track');
  return { events, finalized: false, consumed: end };
}

export function parseSmf(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const anomalies = [];
  const report = (code, message, extra = {}) => anomalies.push({ code, track: null, tick: null, ...extra, message });

  if (bytes.length < HEADER_LENGTH) {
    report('truncated-header', '文件短于 MThd 头部长度', { byteLength: bytes.length });
    return { complete: false, header: null, division: null, tracks: [], events: [], anomalies };
  }
  if (bytes.subarray(0, 4).toString('latin1') !== 'MThd') {
    report('bad-signature', '文件头不是 MThd');
    return { complete: false, header: null, division: null, tracks: [], events: [], anomalies };
  }
  const headerLength = readUint32(bytes, 4);
  const format = bytes.readUInt16BE(8);
  const trackCount = bytes.readUInt16BE(10);
  const divisionWord = bytes.readUInt16BE(12);

  if (![0, 1].includes(format)) {
    report('unsupported-format', `仅支持 SMF format 0/1，收到 format ${format}`, { format });
    return { complete: false, header: { format, trackCount, divisionWord }, division: null, tracks: [], events: [], anomalies };
  }
  if (divisionWord & 0x8000) {
    // SMPTE division 必须明确报不支持，而不是套用 PPQN 换算。
    report('unsupported-division', `不支持 SMPTE division（0x${divisionWord.toString(16)}），仅支持 PPQN`, { divisionWord });
    return { complete: false, header: { format, trackCount, divisionWord }, division: null, tracks: [], events: [], anomalies };
  }
  const ppqn = divisionWord;
  if (ppqn === 0) report('invalid-division', 'PPQN 为 0，时间无法换算', { ppqn });

  let cursor = 8 + headerLength;
  const tracks = [];
  let fileTruncated = false;
  while (cursor + 8 <= bytes.length) {
    const chunkType = bytes.subarray(cursor, cursor + 4).toString('latin1');
    const chunkLength = readUint32(bytes, cursor + 4);
    const bodyStart = cursor + 8;
    if (chunkType !== 'MTrk') {
      // 非轨道数据块不占轨道序号，记录后按声明长度跳过。
      report('unknown-chunk', `跳过非 MTrk 数据块 ${JSON.stringify(chunkType)}`, { chunkType, chunkLength });
      cursor = bodyStart + chunkLength;
      continue;
    }
    if (tracks.length >= trackCount) {
      report('extra-track', `MTrk 数量超出头部声明的 ${trackCount} 轨`, { track: tracks.length, chunkLength });
      cursor = bodyStart + chunkLength;
      continue;
    }
    if (bodyStart + chunkLength > bytes.length) {
      report('truncated-track', 'MTrk 声明长度超出文件边界', { track: tracks.length, declaredLength: chunkLength, available: bytes.length - bodyStart });
      const parsed = parseTrack(tracks.length, bytes, bodyStart, bytes.length - bodyStart, anomalies);
      tracks.push({ index: tracks.length, declaredLength: chunkLength, finalized: false, truncated: true, events: parsed.events });
      fileTruncated = true;
      cursor = bytes.length;
      break;
    }
    const parsed = parseTrack(tracks.length, bytes, bodyStart, chunkLength, anomalies);
    tracks.push({ index: tracks.length, declaredLength: chunkLength, finalized: parsed.finalized, truncated: !parsed.finalized, events: parsed.events });
    if (!parsed.finalized) fileTruncated = true;
    cursor = bodyStart + chunkLength;
  }

  if (cursor < bytes.length && tracks.length >= trackCount) {
    report('trailing-bytes', '最后一个轨道之后仍有未解释字节', { byteLength: bytes.length - cursor });
  }
  if (tracks.length < trackCount) {
    report('missing-track', `头部声明 ${trackCount} 轨，实际只解析到 ${tracks.length} 轨`, { declared: trackCount, actual: tracks.length });
    fileTruncated = true;
  }

  const events = tracks.flatMap(track => track.events);
  return {
    complete: !fileTruncated && !anomalies.some(item => item.code.startsWith('truncated') || item.code === 'missing-end-of-track'),
    header: { format, trackCount, divisionWord },
    division: { type: 'ppqn', ppqn },
    tracks,
    events,
    defaultTempo: DEFAULT_TEMPO_US_PER_QUARTER,
    anomalies,
  };
}
