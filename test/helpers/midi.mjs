// 测试专用 SMF 字节构造器：本地合成业务样本，不依赖第三方库。
function vlq(value) {
  const bytes = [value & 0x7f];
  let rest = value >>> 7;
  while (rest > 0) { bytes.unshift((rest & 0x7f) | 0x80); rest = rest >>> 7; }
  return Buffer.from(bytes);
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.write(type, 0, 'latin1');
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
}

// events: [{ delta, bytes: Buffer }]
export function track(events) {
  const body = Buffer.concat(events.map(event => Buffer.concat([vlq(event.delta), event.bytes])));
  return chunk('MTrk', body);
}

export function header(format, trackCount, ppqn) {
  const body = Buffer.alloc(6);
  body.writeUInt16BE(format, 0);
  body.writeUInt16BE(trackCount, 2);
  body.writeUInt16BE(ppqn, 4);
  return chunk('MThd', body);
}

export const message = {
  noteOn: (channel, pitch, velocity) => Buffer.from([0x90 | channel, pitch, velocity]),
  noteOff: (channel, pitch, velocity = 0) => Buffer.from([0x80 | channel, pitch, velocity]),
  cc: (channel, controller, value) => Buffer.from([0xb0 | channel, controller, value]),
  program: (channel, program) => Buffer.from([0xc0 | channel, program]),
  tempo: usPerQuarter => Buffer.from([0xff, 0x51, 0x03, (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff]),
  end: () => Buffer.from([0xff, 0x2f, 0x00]),
};

export function smf({ format = 1, ppqn = 480, tracks: trackList }) {
  return Buffer.concat([header(format, trackList.length, ppqn), ...trackList]);
}
