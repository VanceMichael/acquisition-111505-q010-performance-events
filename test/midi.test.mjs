import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MidiError, parseMidi } from '../src/midi.mjs';

const fixture = await readFile(new URL('../fixtures/lesson.mid', import.meta.url));
const bytes = (...values) => Buffer.from(values.flat());
const vlq = value => {
  const encoded = [value & 0x7f];
  let remaining = value >> 7;
  while (remaining > 0) { encoded.unshift((remaining & 0x7f) | 0x80); remaining >>= 7; }
  return encoded;
};
const meta = (type, data = []) => [0xff, type, ...vlq(data.length), ...data];
const track = (...events) => {
  const body = events.flat();
  const length = body.length;
  return bytes([0x4d, 0x54, 0x72, 0x6b, (length >>> 24) & 0xff, (length >>> 16) & 0xff,
    (length >>> 8) & 0xff, length & 0xff], body);
};
const song = (format, division, ...tracks) => Buffer.concat([
  bytes([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6,
    (format >> 8) & 0xff, format & 0xff,
    (tracks.length >> 8) & 0xff, tracks.length & 0xff,
    (division >> 8) & 0xff, division & 0xff]),
  ...tracks,
]);

test('教学样本按速度事件换算绝对时间并跨轨共享通道踏板', () => {
  const parsed = parseMidi(fixture);
  assert.equal(parsed.format, 1);
  assert.equal(parsed.parsedTrackCount, 3);
  assert.equal(parsed.ticksPerQuarter, 480);
  assert.equal(parsed.durationTicks, 960);
  assert.equal(parsed.durationMs, 1500);
  assert.equal(parsed.tempoMap.length, 2);
  assert.equal(parsed.tempoMap[0].microsecondsPerQuarter, 500000);
  assert.equal(parsed.tempoMap[1].tick, 480);
  assert.equal(parsed.tempoMap[1].microsecondsPerQuarter, 1000000);
  assert.equal(parsed.complete, true);
  assert.equal(parsed.performanceComplete, true);
  assert.equal(parsed.performanceCertain, false);

  assert.equal(parsed.notes.length, 2);
  const [first, second] = parsed.notes;
  assert.equal(first.track, 1);
  assert.equal(first.pressed, 0);
  assert.equal(first.pressedMs, 0);
  assert.equal(first.released, 480);
  assert.equal(first.releasedMs, 500);
  assert.equal(first.soundingUntil, 960);
  assert.equal(first.soundingUntilMs, 1500);
  assert.equal(first.endReason, 'sustain-pedal-up');
  assert.equal(second.pressed, 240);
  assert.equal(second.released, 720);
  assert.equal(second.releasedMs, 1000);
  assert.equal(second.soundingUntil, 960);
  assert.equal(second.sustainAtPress, true);

  const channel = parsed.channels.find(item => item.channel === 0);
  assert.equal(channel.pedalDown, false);
  assert.equal(channel.controllerChanges.length, 2);
  assert.equal(channel.controllerChanges[0].track, 2);
  assert.equal(channel.noteOns, 2);
  assert.equal(channel.noteOffs, 2);
  assert.equal(parsed.notes[0].soundingEnd.track, 2);
  assert.equal(parsed.notes[0].soundingEnd.reason, 'sustain-pedal-up');
  assert.equal(parsed.notes[0].noteOff.track, 1);

  const pedalEvents = parsed.rawEvents.filter(event => event.type === 'controlChange');
  assert.deepEqual(pedalEvents.map(event => event.tick), [0, 960]);
});

test('同音高叠按按先进先出配对并保留歧义，不合并区间', () => {
  const parsed = parseMidi(fixture);
  assert.equal(parsed.notes[0].pairing.ambiguous, true);
  assert.equal(parsed.notes[0].pairing.candidates, 2);
  assert.equal(parsed.ambiguities.length, 1);
  assert.equal(parsed.notes[0].released, 480);
  assert.equal(parsed.notes[1].released, 720);
  assert.ok(parsed.diagnostics.some(item => item.code === 'ambiguous-note-pairing'));
});

test('原始事件顺序按轨内位置保留，同 tick 不跨轨编造先后', () => {
  const parsed = parseMidi(fixture);
  assert.equal(parsed.events.length, parsed.rawEvents.length);
  const rawKeys = parsed.rawEvents.map(event => `${event.track}:${event.index}:${event.fileOrder}`);
  assert.deepEqual(rawKeys, [...rawKeys].sort((left, right) => {
    const [lt, li] = left.split(':').map(Number);
    const [rt, ri] = right.split(':').map(Number);
    return lt - rt || li - ri;
  }));
  const shared = parsed.events.filter(event => event.tick === 480);
  assert.ok(shared.length > 0);
  for (let index = 1; index < parsed.events.length; index += 1) {
    const before = parsed.events[index - 1];
    const after = parsed.events[index];
    assert.ok(before.tick < after.tick
      || (before.tick === after.tick && before.track < after.track)
      || (before.tick === after.tick && before.track === after.track && before.index < after.index));
  }
});

test('截断文件保留可读事件，末端音符标为不确定而不伪造完整演奏', () => {
  const truncated = fixture.subarray(0, fixture.length - 5);
  const parsed = parseMidi(truncated);
  assert.equal(parsed.complete, false);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.performanceComplete, false);
  assert.equal(parsed.performanceCertain, false);
  assert.equal(parsed.durationTicks, 960);
  assert.ok(parsed.diagnostics.some(item => item.code === 'truncated-track'));
  assert.ok(parsed.diagnostics.some(item => item.code === 'truncated-event'));
  assert.equal(parsed.openNotes.length, 2);
  for (const note of parsed.notes) {
    assert.equal(note.openAtSourceEnd, true);
    assert.equal(note.boundaryUncertain, true);
    assert.equal(note.endReason, 'sustain-pedal-unreleased');
    assert.equal(note.releaseKnown, true);
    assert.equal(note.complete, false);
    assert.equal(note.soundingEndKnown, false);
  }
  assert.ok(parsed.diagnostics.filter(item => item.code === 'open-note-at-source-end')
    .every(item => item.severity === 'error'));
});

test('无匹配松键单独记录，不并进相邻音符', () => {
  const file = song(0, 96,
    track(vlq(0), [0x90, 60, 100], vlq(96), [0x80, 62, 64], vlq(96), [0x80, 60, 0], vlq(0), meta(0x2f)));
  const parsed = parseMidi(file);
  assert.equal(parsed.notes.length, 1);
  assert.equal(parsed.notes[0].pressed, 0);
  assert.equal(parsed.notes[0].released, 192);
  assert.equal(parsed.unmatchedNoteOffs.length, 1);
  assert.equal(parsed.unmatchedNoteOffs[0].pitch, 62);
  assert.equal(parsed.unmatchedNoteOffs[0].tick, 96);
  assert.equal(parsed.unmatchedNoteOffs[0].reason, 'no-pressed-note');
  assert.equal(parsed.performanceComplete, false);
  const event = parsed.events.find(item => item.type === 'noteOff' && item.pitch === 62);
  assert.equal(event.unmatched, true);
});

test('乐器与控制器状态按通道解释，跨轨事件作用于同一通道', () => {
  const file = song(1, 96,
    track(vlq(0), meta(0x03, [...Buffer.from('联合排演')]), vlq(0), [0xc0, 5], vlq(0), [0xb0, 64, 127], vlq(0), meta(0x2f)),
    track(vlq(0), [0x90, 64, 90], vlq(96), [0x80, 64, 0], vlq(0), meta(0x2f)));
  const parsed = parseMidi(file);
  assert.equal(parsed.notes.length, 1);
  assert.equal(parsed.notes[0].program, 5);
  assert.equal(parsed.notes[0].sustainAtPress, true);
  assert.equal(parsed.notes[0].released, 96);
  assert.equal(parsed.notes[0].soundingUntil, 96);
  assert.equal(parsed.notes[0].endReason, 'sustain-pedal-unreleased');
  assert.equal(parsed.notes[0].releaseKnown, true);
  const channel = parsed.channels[0];
  assert.equal(channel.program, 5);
  assert.equal(channel.pedalDown, true);
  assert.equal(channel.controllerChanges[0].track, 0);
  assert.equal(parsed.tracks[0].name, '联合排演');
});

test('全部声音停止结束发声但松键未知，全部音符停止释放按住的键', () => {
  const soundOff = song(0, 96, track(
    vlq(0), [0x90, 60, 100], vlq(48), [0xb0, 120, 0], vlq(48), meta(0x2f),
  ));
  const parsedOff = parseMidi(soundOff);
  assert.equal(parsedOff.notes[0].soundingUntil, 48);
  assert.equal(parsedOff.notes[0].endReason, 'all-sound-off');
  assert.equal(parsedOff.notes[0].releaseKnown, false);
  assert.equal(parsedOff.notes[0].released, null);
  assert.equal(parsedOff.unresolvedReleases[0].cause, 'all-sound-off');
  assert.equal(parsedOff.performanceCertain, false);

  const notesOff = song(0, 96, track(
    vlq(0), [0x90, 60, 100], vlq(48), [0xb0, 123, 0], vlq(48), meta(0x2f),
  ));
  const parsedNotes = parseMidi(notesOff);
  assert.equal(parsedNotes.notes[0].released, 48);
  assert.equal(parsedNotes.notes[0].releaseReason, 'all-notes-off');
  assert.equal(parsedNotes.notes[0].soundingUntil, 48);
  assert.equal(parsedNotes.performanceCertain, true);
});

test('踏板下全部音符停止时松键已知而发声边界等待踏板抬起', () => {
  const file = song(0, 96, track(
    vlq(0), [0xb0, 64, 127], vlq(0), [0x90, 60, 100],
    vlq(48), [0xb0, 123, 0], vlq(48), [0xb0, 64, 0], vlq(0), meta(0x2f),
  ));
  const parsed = parseMidi(file);
  assert.equal(parsed.notes[0].released, 48);
  assert.equal(parsed.notes[0].soundingUntil, 96);
  assert.equal(parsed.notes[0].endReason, 'sustain-pedal-up');
});

test('按下所在轨道提前结束而松键未出现时，记录轨道边界而不假装松键', () => {
  const file = song(1, 96,
    track(vlq(0), [0x90, 60, 100], vlq(24), meta(0x2f)),
    track(vlq(0), [0xb0, 64, 127], vlq(96), meta(0x2f)));
  const parsed = parseMidi(file);
  const [note] = parsed.notes;
  assert.equal(parsed.tracks[0].endOfTrack, true);
  assert.equal(parsed.tracks[0].endTick, 24);
  assert.equal(note.trackEndedBeforeNoteOff, true);
  assert.equal(note.trackEnd.tick, 24);
  assert.equal(note.releaseKnown, false);
  assert.equal(note.openAtSourceEnd, true);
  assert.equal(note.soundingUntil, 96);
  assert.ok(parsed.diagnostics.some(item => item.code === 'track-ended-before-note-off'));
  assert.equal(parsed.performanceComplete, false);
});

test('缺少结束事件时以最后完整事件为边界并留下记录', () => {
  const file = song(0, 96, track(vlq(0), [0x90, 60, 100], vlq(96), [0x80, 60, 0]));
  const parsed = parseMidi(file);
  assert.equal(parsed.complete, false);
  assert.ok(parsed.diagnostics.some(item => item.code === 'missing-end-of-track'));
  assert.equal(parsed.notes[0].released, 96);
  assert.equal(parsed.notes[0].complete, true);
  assert.equal(parsed.performanceComplete, false);
});

test('运行状态与零力度 note-on 按 MIDI 语义解释', () => {
  const file = song(0, 96, track(
    vlq(0), [0x90, 60, 100], vlq(10), [60, 80], vlq(10), [60, 0], vlq(0), meta(0x2f),
  ));
  const parsed = parseMidi(file);
  assert.equal(parsed.events.filter(event => event.type === 'noteOn').length, 2);
  assert.equal(parsed.events.filter(event => event.type === 'noteOff').length, 1);
  assert.equal(parsed.events[1].runningStatus, true);
  assert.equal(parsed.events[2].noteOnZeroVelocity, true);
  assert.equal(parsed.notes.length, 2);
  assert.equal(parsed.notes[0].released, 20);
  assert.equal(parsed.notes[1].released, 20);
  assert.equal(parsed.notes[0].pairing.candidates, 2);
});

test('拒绝 SMPTE 与 format 2 而不套用 PPQN', () => {
  assert.throws(() => parseMidi(song(1, 0xe250, track(meta(0x2f)))), error => {
    assert.ok(error instanceof MidiError);
    assert.equal(error.code, 'UNSUPPORTED_DIVISION');
    return true;
  });
  assert.throws(() => parseMidi(song(2, 96, track(meta(0x2f)))), error => {
    assert.equal(error.code, 'UNSUPPORTED_FORMAT');
    return true;
  });
  assert.throws(() => parseMidi(Buffer.from('not a midi file')), error => {
    assert.equal(error.code, 'NOT_MIDI');
    return true;
  });
});

test('零字节速度事件不使用伪换算，并保留错误记录', () => {
  const file = song(0, 96, track(vlq(0), meta(0x51, [0, 0, 0]), vlq(96), meta(0x2f)));
  const parsed = parseMidi(file);
  assert.ok(parsed.diagnostics.some(item => item.code === 'invalid-tempo'));
  assert.equal(parsed.tempoMap[0].default, true);
  assert.equal(parsed.durationMs, 500);
});
