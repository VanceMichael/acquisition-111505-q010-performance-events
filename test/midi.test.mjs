import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyzePerformance } from '../src/midi/analyze.mjs';
import { smf, track, message, header } from './helpers/midi.mjs';

const lesson = await readFile(new URL('../fixtures/lesson.mid', import.meta.url));

test('教学样本：速度换算、跨轨踏板与叠键 FIFO 都保留证据', () => {
  const result = analyzePerformance(lesson);
  assert.equal(result.complete, true);
  assert.deepEqual(result.header, { format: 1, trackCount: 3, divisionWord: 480 });
  assert.equal(result.division.ppqn, 480);
  // 速度事件作用整份文件：tick 480 起 1000000us/四分音符。
  assert.deepEqual(result.tempoMap, [{ tick: 0, usPerQuarter: 500000 }, { tick: 480, usPerQuarter: 1000000 }]);
  assert.equal(result.notes.length, 2);
  const [first, second] = result.notes;
  // 与人工记录 fixture 同形：pressed 0、released 480、soundingUntil 960。
  assert.equal(first.pressed.tick, 0);
  assert.equal(first.released.tick, 480);
  assert.equal(first.sounding.end.tick, 960);
  assert.equal(first.endReason, 'sustain-release');
  assert.equal(second.pressed.tick, 240);
  assert.equal(second.released.tick, 720);
  assert.equal(second.sounding.end.tick, 960);
  // 速度变化后的时间：240 tick 在旧速度下 250ms，720 tick = 500ms + 240/480*1000ms。
  assert.equal(first.pressed.millis, 0);
  assert.equal(first.released.millis, 500);
  assert.equal(first.sounding.end.millis, 1500);
  assert.equal(second.released.millis, 1000);
  // 松键在音符轨、踏板在另一轨，但同属通道 0，互相影响。
  assert.equal(first.pressed.track, 1);
  assert.equal(result.channels[0].controllers[64].value, 0);
  assert.equal(result.channels[0].controllers[64].previous, 127);
  assert.equal(result.channels[0].sustainIntervals[0].end.tick, 960);
  // 同音高叠键：第一个松键归属有歧义，按 FIFO 记录，不修饰成完美演奏。
  assert.equal(first.ambiguousMatch, true);
  assert.equal(second.ambiguousMatch, false);
  assert.equal(result.anomalies.some(item => item.code === 'ambiguous-match' && item.candidates === 2), true);
});

test('原始事件顺序保留全局 tick 与同 tick 轨序，不跨轨臆造先后', () => {
  const result = analyzePerformance(lesson);
  const ticks = result.events.map(event => event.tick);
  assert.deepEqual(ticks, [...ticks].sort((a, b) => a - b));
  const atZero = result.events.filter(event => event.tick === 0);
  assert.deepEqual(atZero.map(event => event.track), [0, 1, 2]);
  assert.deepEqual(atZero.map(event => event.order), [0, 0, 0]);
  assert.equal(result.events.every(event => Array.isArray(event.raw) && event.raw.length > 0), true);
});

test('无踏板时松键即发声结束；程序变化按通道记录乐器', () => {
  const file = smf({
    tracks: [
      track([
        { delta: 0, bytes: message.program(2, 17) },
        { delta: 0, bytes: message.noteOn(2, 64, 90) },
        { delta: 240, bytes: message.noteOff(2, 64) },
        { delta: 0, bytes: message.end() },
      ]),
    ],
  });
  const result = analyzePerformance(file);
  assert.equal(result.complete, true);
  assert.equal(result.notes.length, 1);
  const note = result.notes[0];
  assert.equal(note.channel, 2);
  assert.equal(note.program, 17);
  assert.equal(note.released.tick, 240);
  assert.equal(note.sounding.end.tick, 240);
  assert.equal(note.endReason, 'note-off');
  assert.equal(note.inferredEnd, false);
  assert.equal(result.channels[2].program, 17);
});

test('力度 0 的 note-on 视同松键并保留来源写法', () => {
  const file = smf({
    tracks: [track([
      { delta: 0, bytes: message.noteOn(0, 72, 80) },
      { delta: 120, bytes: message.noteOn(0, 72, 0) },
      { delta: 0, bytes: message.end() },
    ])],
  });
  const result = analyzePerformance(file);
  assert.equal(result.notes[0].released.via, 'note-on-velocity-zero');
  assert.equal(result.notes[0].sounding.end.tick, 120);
  assert.equal(result.events.some(event => event.type === 'note-on-zero'), true);
});

test('无匹配松键明确记录 orphan，不伪造音符', () => {
  const file = smf({
    tracks: [track([
      { delta: 0, bytes: message.noteOff(3, 55) },
      { delta: 0, bytes: message.noteOn(3, 55, 70) },
      { delta: 60, bytes: message.end() },
    ])],
  });
  const result = analyzePerformance(file);
  assert.equal(result.notes.length, 1);
  assert.equal(result.anomalies.some(item => item.code === 'orphan-note-off' && item.channel === 3 && item.pitch === 55), true);
});

test('延音踏板：松键与发声结束分离，抬踏板统一结束', () => {
  const file = smf({
    tracks: [
      track([
        { delta: 0, bytes: message.cc(0, 64, 100) },
        { delta: 0, bytes: message.noteOn(0, 60, 90) },
        { delta: 100, bytes: message.noteOff(0, 60) },
        { delta: 200, bytes: message.cc(0, 64, 0) },
        { delta: 0, bytes: message.end() },
      ]),
    ],
  });
  const result = analyzePerformance(file);
  const note = result.notes[0];
  assert.equal(note.released.tick, 100);
  assert.equal(note.sounding.end.tick, 300);
  assert.equal(note.endReason, 'sustain-release');
  assert.equal(result.channels[0].sustain.down, false);
  assert.equal(result.channels[0].sustainIntervals[0].open, false);
});

test('all-sound-off 立即结束发声，all-notes-off 仍尊重踏板', () => {
  const soundOff = smf({
    tracks: [track([
      { delta: 0, bytes: message.noteOn(0, 60, 90) },
      { delta: 50, bytes: message.cc(0, 120, 0) },
      { delta: 0, bytes: message.end() },
    ])],
  });
  const a = analyzePerformance(soundOff);
  assert.equal(a.notes[0].sounding.end.tick, 50);
  assert.equal(a.notes[0].endReason, 'all-sound-off');
  assert.equal(a.anomalies.some(item => item.code === 'note-off-missing'), true);

  const notesOffWithPedal = smf({
    tracks: [track([
      { delta: 0, bytes: message.cc(0, 64, 127) },
      { delta: 0, bytes: message.noteOn(0, 60, 90) },
      { delta: 50, bytes: message.cc(0, 123, 0) },
      { delta: 100, bytes: message.cc(0, 64, 0) },
      { delta: 0, bytes: message.end() },
    ])],
  });
  const b = analyzePerformance(notesOffWithPedal);
  assert.equal(b.notes[0].released, null);
  assert.equal(b.notes[0].sounding.end.tick, 150);
  assert.equal(b.notes[0].endReason, 'sustain-release');
});

test('轨道提前结束只推断本轨音符边界，其他轨音符继续保留', () => {
  const file = smf({
    tracks: [
      track([
        { delta: 0, bytes: message.noteOn(0, 60, 90) },
        { delta: 100, bytes: message.end() },
      ]),
      track([
        { delta: 0, bytes: message.noteOn(0, 72, 90) },
        { delta: 300, bytes: message.noteOff(0, 72) },
        { delta: 0, bytes: message.end() },
      ]),
    ],
  });
  const result = analyzePerformance(file);
  const early = result.notes.find(note => note.pitch === 60);
  const kept = result.notes.find(note => note.pitch === 72);
  assert.equal(early.sounding.end.tick, 100);
  assert.equal(early.endReason, 'track-end');
  assert.equal(early.inferredEnd, true);
  assert.equal(kept.sounding.end.tick, 300);
  assert.equal(kept.endReason, 'note-off');
  assert.equal(result.anomalies.some(item => item.code === 'note-off-missing' && item.stop === 'track-end'), true);
});

test('截断文件忠实保留已解析事件与截断边界', async () => {
  const truncated = lesson.subarray(0, lesson.length - 5);
  const result = analyzePerformance(truncated);
  assert.equal(result.accepted, true);
  assert.equal(result.complete, false);
  assert.equal(result.anomalies.some(item => item.code === 'truncated-track'), true);
  // 截断前的事件仍是可检索证据。
  assert.ok(result.events.length > 0);
  assert.equal(result.boundaries.truncatedTracks.includes(2), true);
  const open = result.notes.filter(note => note.inferredEnd);
  assert.ok(open.length >= 1);
  assert.equal(open.every(note => note.endReason === 'truncated' || note.endReason === 'end-of-file'), true);
});

test('文件结束仍未闭合的音符按来源边界标注，不补写松键', () => {
  // 轨道缺少 end-of-track：属于截断，未闭合音符取截断边界。
  const cut = smf({
    tracks: [track([
      { delta: 0, bytes: message.noteOn(1, 80, 90) },
      { delta: 200, bytes: message.noteOn(1, 81, 90) },
    ])],
  });
  const cutResult = analyzePerformance(cut);
  assert.equal(cutResult.complete, false);
  assert.equal(cutResult.notes.length, 2);
  for (const note of cutResult.notes) {
    assert.equal(note.sounding.end.tick, 200);
    assert.equal(note.endReason, 'truncated');
    assert.equal(note.inferredEnd, true);
  }
  assert.equal(cutResult.anomalies.filter(item => item.code === 'unclosed-note' && item.boundary === 'truncated').length, 2);

  // 轨道正常结束但音符来自一条已被 EOT 跳过之外仍开着的场景：多轨中另一轨尚未结束。
  const mixed = smf({
    tracks: [
      track([
        { delta: 0, bytes: message.noteOn(0, 80, 90) },
        { delta: 100, bytes: message.end() },
      ]),
      track([
        { delta: 300, bytes: message.end() },
      ]),
    ],
  });
  const mixedResult = analyzePerformance(mixed);
  const note = mixedResult.notes[0];
  // 本轨 EOT 能确定边界时优先 track-end；文件整体结束仍开着的音符才标 end-of-file。
  assert.equal(note.endReason, 'track-end');
  assert.equal(note.inferredEnd, true);
  assert.equal(mixedResult.anomalies.some(item => item.code === 'note-off-missing' && item.stop === 'track-end'), true);
});

test('SMPTE division 明确拒绝，不套用 PPQN', () => {
  const body = Buffer.alloc(6);
  body.writeUInt16BE(1, 0); body.writeUInt16BE(1, 2); body.writeUInt16BE(0x80c8, 4);
  const file = Buffer.concat([Buffer.from('MThd'), Buffer.from([0, 0, 0, 6]), body]);
  const result = analyzePerformance(file);
  assert.equal(result.accepted, false);
  assert.equal(result.anomalies[0].code, 'unsupported-division');
});

test('format 2 与非 MThd 文件被拒绝并留下记录', () => {
  const unsupported = smf({ format: 2, tracks: [track([{ delta: 0, bytes: message.end() }])] });
  const result = analyzePerformance(unsupported);
  assert.equal(result.accepted, false);
  assert.equal(result.anomalies.some(item => item.code === 'unsupported-format'), true);
  const garbage = analyzePerformance(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]));
  assert.equal(garbage.accepted, false);
  assert.equal(garbage.anomalies[0].code, 'bad-signature');
});

test('running status 在同一轨道内延续且新轨道重置', () => {
  // 首事件 90 3c 64 给出状态，后续只给数据字节沿用 note-on；松键显式给 80 状态。
  const first = track([
    { delta: 0, bytes: Buffer.from([0x90, 0x3c, 0x64, 0x40, 0x50, 0x43, 0x40]) },
    { delta: 0, bytes: message.noteOff(0, 60) },
    { delta: 0, bytes: message.noteOff(0, 64) },
    { delta: 0, bytes: message.noteOff(0, 67) },
    { delta: 0, bytes: message.end() },
  ]);
  const broken = track([{ delta: 0, bytes: Buffer.from([0x3c, 0x64]) }]);
  const file = smf({ tracks: [first, broken] });
  const result = analyzePerformance(file);
  assert.equal(result.events.filter(event => event.type === 'note-on').length, 3);
  assert.equal(result.notes.length, 3);
  assert.equal(result.anomalies.some(item => item.code === 'missing-status'), true);
});

test('format 0 单轨多通道事件按通道分别理解', () => {
  const file = smf({
    format: 0,
    tracks: [track([
      { delta: 0, bytes: message.noteOn(0, 60, 90) },
      { delta: 0, bytes: message.noteOn(1, 60, 80) },
      { delta: 120, bytes: message.cc(0, 64, 127) },
      { delta: 0, bytes: message.noteOff(0, 60) },
      { delta: 0, bytes: message.noteOff(1, 60) },
      { delta: 60, bytes: message.cc(0, 64, 0) },
      { delta: 0, bytes: message.end() },
    ])],
  });
  const result = analyzePerformance(file);
  assert.equal(result.header.format, 0);
  assert.equal(result.notes.length, 2);
  const channelZero = result.notes.find(note => note.channel === 0);
  const channelOne = result.notes.find(note => note.channel === 1);
  assert.equal(channelZero.sounding.end.tick, 180);
  assert.equal(channelOne.sounding.end.tick, 120);
  assert.equal(result.channels[0].sustainIntervals.length, 1);
  assert.equal(result.channels[1].sustainIntervals.length, 0);
  assert.equal(result.notes.every(note => note.inferredEnd === false), true);
});

test('未知数据块跳过并记录，不影响 MTrk 解析', () => {
  const extra = Buffer.concat([Buffer.from('MXtr'), Buffer.from([0, 0, 0, 2]), Buffer.from([0xab, 0xcd])]);
  const file = Buffer.concat([
    header(1, 1, 480),
    extra,
    track([
      { delta: 0, bytes: message.noteOn(0, 60, 90) },
      { delta: 100, bytes: message.noteOff(0, 60) },
      { delta: 0, bytes: message.end() },
    ]),
  ]);
  const result = analyzePerformance(file);
  assert.equal(result.complete, true);
  assert.equal(result.notes.length, 1);
  assert.equal(result.anomalies.some(item => item.code === 'unknown-chunk'), true);
});

test('缺失整轨时跨轨通道状态不完整，发声结束回退为推断并留痕', async () => {
  const lesson = await readFile(new URL('../fixtures/lesson.mid', import.meta.url));
  // 截掉整个踏板轨（第三轨），头部仍声明 3 轨。
  const result = analyzePerformance(lesson.subarray(0, lesson.length - 20));
  assert.equal(result.complete, false);
  assert.equal(result.boundaries.missingTracks, true);
  assert.ok(result.anomalies.some(item => item.code === 'missing-track'));
  assert.ok(result.anomalies.some(item => item.code === 'uncertain-end'));
  assert.equal(result.notes.every(note => note.inferredEnd && note.endReason === 'missing-track'), true);
});

test('无速度事件时采用默认 500000us/四分音符换算', () => {
  const file = smf({
    ppqn: 240,
    tracks: [track([
      { delta: 0, bytes: message.noteOn(0, 60, 90) },
      { delta: 240, bytes: message.noteOff(0, 60) },
      { delta: 0, bytes: message.end() },
    ])],
  });
  const result = analyzePerformance(file);
  assert.deepEqual(result.tempoMap, [{ tick: 0, usPerQuarter: 500000 }]);
  assert.equal(result.notes[0].sounding.end.millis, 500);
});
