import { Buffer } from 'node:buffer';

export class MidiError extends Error {
  constructor(message, code = 'MIDI_ERROR', details = {}) {
    super(message);
    this.name = 'MidiError';
    this.code = code;
    this.details = details;
  }
}

const DEFAULT_TEMPO = 500000;
const META_NAMES = new Map([
  [0x00, 'sequence-number'], [0x01, 'text'], [0x02, 'copyright'],
  [0x03, 'track-name'], [0x04, 'instrument-name'], [0x05, 'lyric'],
  [0x06, 'marker'], [0x07, 'cue-point'], [0x20, 'channel-prefix'],
  [0x21, 'midi-port'], [0x2f, 'end-of-track'], [0x51, 'set-tempo'],
  [0x54, 'smpte-offset'], [0x58, 'time-signature'], [0x59, 'key-signature'],
  [0x7f, 'sequencer-specific'],
]);

const round = value => Math.round(value * 1e6) / 1e6;

function readVlq(bytes, offset, end) {
  let value = 0;
  for (let index = 0; index < 4; index += 1) {
    if (offset >= end) return { error: 'truncated-vlq', offset };
    const byte = bytes[offset++];
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, offset };
  }
  return { error: 'vlq-too-long', offset };
}

function diagnostic(diagnostics, code, message, details = {}, severity = 'warning') {
  diagnostics.push({ code, message, severity, ...details });
}

function textValue(data) {
  return Buffer.from(data).toString('utf8');
}

function emptyResult(bytes, diagnostics) {
  return {
    format: null,
    trackCount: 0,
    parsedTrackCount: 0,
    division: null,
    ticksPerQuarter: null,
    timing: null,
    complete: false,
    truncated: true,
    durationTicks: 0,
    durationMs: null,
    durationBoundary: { tick: 0, timeMs: null, basis: 'no-readable-events' },
    tempoMap: [],
    events: [],
    rawEvents: [],
    tracks: [],
    notes: [],
    channels: [],
    unmatchedNoteOffs: [],
    openNotes: [],
    ambiguities: [],
    unresolvedReleases: [],
    intervalsComplete: false,
    performanceComplete: false,
    performanceCertain: false,
    diagnostics,
    counts: {
      tracks: 0, events: 0, notes: 0, unmatchedNoteOffs: 0,
      openNotes: 0, unresolvedReleases: 0, ambiguities: 0,
      diagnostics: diagnostics.length,
    },
    byteLength: bytes.length,
  };
}

function parseTrack(bytes, { trackIndex, bodyStart, bodyEnd, declaredEnd, diagnostics }) {
  const events = [];
  let offset = bodyStart;
  let tick = 0;
  let lastCompleteTick = 0;
  let reachedTick = 0;
  let runningStatus = null;
  let eventIndex = 0;
  let ended = false;
  let endOfTrackTick = null;
  let stoppedByError = false;
  let trackName = null;
  let instrumentName = null;
  const chunkTruncated = declaredEnd > bytes.length;

  while (offset < bodyEnd) {
    const eventStart = offset;
    const deltaResult = readVlq(bytes, offset, bodyEnd);
    if (deltaResult.error) {
      diagnostic(diagnostics, deltaResult.error, '轨道事件的时间增量不完整', {
        track: trackIndex, byteOffset: eventStart, tick: reachedTick,
      }, 'error');
      stoppedByError = true;
      break;
    }
    const delta = deltaResult.value;
    offset = deltaResult.offset;
    const eventTick = tick + delta;
    reachedTick = Math.max(reachedTick, eventTick);

    if (offset >= bodyEnd) {
      diagnostic(diagnostics, chunkTruncated ? 'truncated-event' : 'event-overruns-track',
        '轨道在事件状态字节前结束', {
          track: trackIndex, byteOffset: eventStart, tick: eventTick,
          trackTruncated: chunkTruncated,
        }, 'error');
      stoppedByError = true;
      break;
    }

    const statusAt = offset;
    let status = bytes[offset];
    let explicitStatus = true;
    if ((status & 0x80) === 0) {
      if (runningStatus === null) {
        diagnostic(diagnostics, 'missing-running-status', '数据字节出现在可继承状态之前', {
          track: trackIndex, byteOffset: statusAt, tick: eventTick,
        }, 'error');
        stoppedByError = true;
        break;
      }
      status = runningStatus;
      explicitStatus = false;
    } else {
      offset += 1;
    }

    tick = eventTick;
    const finish = (event) => {
      eventIndex += 1;
      event.index = eventIndex;
      event.track = trackIndex;
      event.trackIndex = trackIndex;
      event.tick = eventTick;
      event.delta = delta;
      event.timeMs = null;
      event.byteOffset = eventStart;
      event.byteLength = offset - eventStart;
      event.runningStatus = !explicitStatus;
      events.push(event);
      lastCompleteTick = eventTick;
    };

    if (status === 0xff) {
      runningStatus = null;
      if (offset >= bodyEnd) {
        diagnostic(diagnostics, chunkTruncated ? 'truncated-meta' : 'event-overruns-track',
          '轨道在元事件类型前结束', {
            track: trackIndex, byteOffset: eventStart, tick: eventTick,
          }, 'error');
        stoppedByError = true;
        break;
      }
      const metaType = bytes[offset++];
      const lengthResult = readVlq(bytes, offset, bodyEnd);
      if (lengthResult.error) {
        diagnostic(diagnostics, lengthResult.error === 'truncated-vlq'
          ? (chunkTruncated ? 'truncated-meta-length' : 'event-overruns-track')
          : 'vlq-too-long', '元事件长度不完整', {
          track: trackIndex, byteOffset: eventStart, tick: eventTick,
        }, 'error');
        stoppedByError = true;
        break;
      }
      const length = lengthResult.value;
      offset = lengthResult.offset;
      if (offset + length > bodyEnd) {
        diagnostic(diagnostics, chunkTruncated ? 'truncated-meta-data' : 'event-overruns-track',
          '元事件内容超出可用字节', {
            track: trackIndex, byteOffset: eventStart, tick: eventTick,
            metaType, declaredLength: length, availableLength: bodyEnd - offset,
          }, 'error');
        stoppedByError = true;
        break;
      }
      const data = bytes.subarray(offset, offset + length);
      offset += length;
      const event = {
        type: metaType === 0x51 ? 'tempo' : metaType === 0x2f ? 'endOfTrack' : 'meta',
        status: 0xff,
        metaType,
        metaTypeName: META_NAMES.get(metaType) ?? 'unknown',
        data: [...data],
      };
      if (metaType === 0x03) trackName = textValue(data);
      if (metaType === 0x04) instrumentName = textValue(data);
      if (metaType === 0x51) {
        if (length !== 3) {
          diagnostic(diagnostics, 'invalid-tempo-length', '速度事件应为 3 字节', {
            track: trackIndex, tick: eventTick, length,
          }, 'error');
        } else {
          event.microsecondsPerQuarter = (data[0] << 16) | (data[1] << 8) | data[2];
          if (event.microsecondsPerQuarter === 0) {
            diagnostic(diagnostics, 'invalid-tempo', '速度事件为 0，无法换算时间', {
              track: trackIndex, tick: eventTick,
            }, 'error');
          } else {
            event.bpm = round(60000000 / event.microsecondsPerQuarter);
          }
        }
      }
      if (metaType === 0x2f) {
        if (length !== 0) {
          diagnostic(diagnostics, 'invalid-end-of-track', '轨道结束事件不应携带内容', {
            track: trackIndex, tick: eventTick, length,
          }, 'warning');
        }
        finish(event);
        ended = true;
        endOfTrackTick = eventTick;
        if (offset < bodyEnd) {
          diagnostic(diagnostics, 'data-after-end-of-track', '轨道结束后仍有未解释字节', {
            track: trackIndex, tick: eventTick, remaining: bodyEnd - offset,
          }, 'warning');
        }
        break;
      }
      finish(event);
      continue;
    }

    if (status === 0xf0 || status === 0xf7) {
      runningStatus = null;
      const lengthResult = readVlq(bytes, offset, bodyEnd);
      if (lengthResult.error) {
        diagnostic(diagnostics, lengthResult.error === 'truncated-vlq'
          ? (chunkTruncated ? 'truncated-sysex-length' : 'event-overruns-track')
          : 'vlq-too-long', '系统独占事件长度不完整', {
          track: trackIndex, byteOffset: eventStart, tick: eventTick,
        }, 'error');
        stoppedByError = true;
        break;
      }
      const length = lengthResult.value;
      offset = lengthResult.offset;
      if (offset + length > bodyEnd) {
        diagnostic(diagnostics, chunkTruncated ? 'truncated-sysex' : 'event-overruns-track',
          '系统独占事件内容超出可用字节', {
            track: trackIndex, byteOffset: eventStart, tick: eventTick,
            declaredLength: length, availableLength: bodyEnd - offset,
          }, 'error');
        stoppedByError = true;
        break;
      }
      const data = bytes.subarray(offset, offset + length);
      offset += length;
      finish({ type: 'sysex', status, data: [...data] });
      continue;
    }

    if (status >= 0xf0) {
      if (status < 0xf8) runningStatus = null;
      const lengths = { 0xf1: 1, 0xf2: 2, 0xf3: 1, 0xf4: 0, 0xf5: 0, 0xf6: 0 };
      const length = lengths[status] ?? 0;
      if (offset + length > bodyEnd) {
        diagnostic(diagnostics, chunkTruncated ? 'truncated-system-event' : 'event-overruns-track',
          '系统事件内容不完整', {
            track: trackIndex, byteOffset: eventStart, tick: eventTick, status,
          }, 'error');
        stoppedByError = true;
        break;
      }
      const data = bytes.subarray(offset, offset + length);
      offset += length;
      diagnostic(diagnostics, 'unsupported-system-event', '演奏文件中出现未纳入子集的系统事件', {
        track: trackIndex, tick: eventTick, status,
      }, 'warning');
      finish({ type: 'system', status, data: [...data] });
      continue;
    }

    runningStatus = status;
    const family = status & 0xf0;
    const channel = status & 0x0f;
    const dataLength = family === 0xc0 || family === 0xd0 ? 1 : 2;
    if (offset + dataLength > bodyEnd) {
      diagnostic(diagnostics, chunkTruncated ? 'truncated-event' : 'event-overruns-track',
        '通道事件的数据字节不完整', {
          track: trackIndex, byteOffset: eventStart, tick: eventTick, status,
          needed: dataLength, available: bodyEnd - offset,
        }, 'error');
      stoppedByError = true;
      break;
    }
    const data1 = bytes[offset];
    const data2 = dataLength === 2 ? bytes[offset + 1] : null;
    offset += dataLength;
    if ((data1 & 0x80) !== 0 || (data2 !== null && (data2 & 0x80) !== 0)) {
      diagnostic(diagnostics, 'invalid-data-byte', '通道事件的数据字节包含状态位', {
        track: trackIndex, byteOffset: eventStart, tick: eventTick, status,
        data: data2 === null ? [data1] : [data1, data2],
      }, 'error');
      stoppedByError = true;
      break;
    }
    const data = dataLength === 2 ? [data1, data2] : [data1];
    const base = { status, channel, data };

    switch (family) {
      case 0x80:
        finish({ ...base, type: 'noteOff', note: data1, pitch: data1, velocity: data2, releaseVelocity: data2 });
        break;
      case 0x90:
        if (data2 === 0) {
          finish({
            ...base, type: 'noteOff', note: data1, pitch: data1, velocity: 0,
            releaseVelocity: 0, noteOnZeroVelocity: true,
          });
        } else {
          finish({ ...base, type: 'noteOn', note: data1, pitch: data1, velocity: data2 });
        }
        break;
      case 0xa0:
        finish({ ...base, type: 'polyPressure', note: data1, pitch: data1, pressure: data2 });
        break;
      case 0xb0:
        finish({ ...base, type: 'controlChange', controller: data1, value: data2 });
        break;
      case 0xc0:
        finish({ ...base, type: 'programChange', program: data1 });
        break;
      case 0xd0:
        finish({ ...base, type: 'channelPressure', pressure: data1 });
        break;
      case 0xe0: {
        const value = data1 | (data2 << 7);
        finish({ ...base, type: 'pitchBend', value, bend: value - 8192 });
        break;
      }
      default:
        diagnostic(diagnostics, 'unknown-channel-event', '无法识别的通道事件', {
          track: trackIndex, tick: eventTick, status,
        }, 'error');
        stoppedByError = true;
        break;
    }
    if (stoppedByError) break;
  }

  if (!ended && !stoppedByError) {
    diagnostic(diagnostics, 'missing-end-of-track', '轨道没有结束事件，终止边界来自可用字节的末端', {
      track: trackIndex, lastCompleteTick, lastReachedTick: reachedTick,
    }, 'warning');
  }
  if (chunkTruncated) {
    diagnostic(diagnostics, 'truncated-track', '轨道长度超过文件实际字节', {
      track: trackIndex, declaredLength: declaredEnd - bodyStart,
      availableLength: bytes.length - bodyStart, lastCompleteTick,
      lastReachedTick: reachedTick,
    }, 'error');
  }

  return {
    index: trackIndex,
    offset: bodyStart - 8,
    declaredLength: declaredEnd - bodyStart,
    availableLength: Math.max(0, bodyEnd - bodyStart),
    name: trackName,
    instrumentName,
    events,
    eventCount: events.length,
    lastCompleteTick,
    lastReachedTick: Math.max(reachedTick, lastCompleteTick),
    endTick: lastCompleteTick,
    endOfTrack: ended,
    endOfTrackTick,
    complete: ended && !chunkTruncated && !stoppedByError,
    trailingBytesAfterEndOfTrack: ended ? Math.max(0, bodyEnd - offset) : 0,
    truncated: chunkTruncated,
  };
}

function buildTimeline(events, ticksPerQuarter, durationTicks) {
  const tempoMap = [];
  const tempoEvents = events.filter(event => event.type === 'tempo'
    && Number.isFinite(event.microsecondsPerQuarter)
    && event.microsecondsPerQuarter > 0);
  const startsWithTempo = tempoEvents.some(event => event.tick === 0);
  if (!startsWithTempo) {
    tempoMap.push({
      tick: 0, microsecondsPerQuarter: DEFAULT_TEMPO, bpm: 120,
      default: true, track: null, index: null, sequence: null,
    });
  }
  for (const event of tempoEvents) {
    tempoMap.push({
      tick: event.tick,
      microsecondsPerQuarter: event.microsecondsPerQuarter,
      bpm: event.bpm,
      default: false,
      track: event.track,
      index: event.index,
      sequence: event.sequence,
    });
  }
  tempoMap.sort((left, right) => left.tick - right.tick
    || (left.track ?? -1) - (right.track ?? -1)
    || (left.index ?? -1) - (right.index ?? -1));

  const millisecondsAt = (targetTick) => {
    let elapsed = 0;
    let previousTick = 0;
    let tempo = DEFAULT_TEMPO;
    for (const change of tempoMap) {
      if (change.tick <= previousTick) {
        tempo = change.microsecondsPerQuarter;
        continue;
      }
      if (change.tick >= targetTick) break;
      elapsed += (change.tick - previousTick) * tempo / ticksPerQuarter / 1000;
      previousTick = change.tick;
      tempo = change.microsecondsPerQuarter;
    }
    elapsed += (targetTick - previousTick) * tempo / ticksPerQuarter / 1000;
    return round(elapsed);
  };

  for (const event of events) event.timeMs = millisecondsAt(event.tick);
  return { tempoMap, millisecondsAt, durationMs: millisecondsAt(durationTicks) };
}

function interpret(parsed, diagnostics) {
  const notes = [];
  const active = new Map();
  const sounding = new Set();
  const channelStates = new Map();
  const unmatchedNoteOffs = [];
  const ambiguities = [];
  const unresolvedReleases = [];
  let noteCounter = 0;

  const channelState = (channel) => {
    if (!channelStates.has(channel)) {
      channelStates.set(channel, {
        channel,
        program: null,
        pedalDown: false,
        pedalValue: null,
        controllers: {},
        programs: [],
        controllerChanges: [],
        noteOns: 0,
        noteOffs: 0,
        unmatchedNoteOffs: 0,
      });
    }
    return channelStates.get(channel);
  };
  const queueFor = (channel, pitch) => {
    if (!active.has(channel)) active.set(channel, new Map());
    const pitches = active.get(channel);
    if (!pitches.has(pitch)) pitches.set(pitch, []);
    return pitches.get(pitch);
  };
  const endSounding = (note, tick, milliseconds, reason, source = null) => {
    if (note.soundingUntil !== null) return false;
    note.soundingUntil = tick;
    note.soundingUntilMs = milliseconds;
    note.endReason = reason;
    note.soundingEnd = {
      tick, timeMs: milliseconds, reason,
      track: source?.track ?? null,
      index: source?.index ?? null,
      sequence: source?.sequence ?? null,
    };
    note.soundingDurationMs = round(milliseconds - note.pressedMs);
    note.boundaryUncertain = false;
    sounding.delete(note);
    return true;
  };
  const closeHeld = (state, tick, milliseconds, reason, source = null) => {
    for (const note of [...sounding]) {
      if (note.channel !== state.channel || !note.sustainPending) continue;
      if (note.soundingUntil !== null) continue;
      endSounding(note, tick, milliseconds, reason, source);
      note.sustainPending = false;
    }
  };
  const terminateChannel = (state, tick, milliseconds, reason, source = null) => {
    const channelNotes = [...sounding].filter(note => note.channel === state.channel);
    for (const note of channelNotes) {
      if (reason === 'all-sound-off') {
        // All Sound Off silences output; it says nothing about which keys are
        // still held, so the release stays unknown unless a note-off arrives.
        if (note.soundingUntil === null) endSounding(note, tick, milliseconds, reason, source);
        note.sustainPending = false;
        note.terminatedBy = reason;
        note.terminatedAt = { tick, timeMs: milliseconds, track: source?.track ?? null };
        continue;
      }
      // All Notes Off releases held keys. A note already released stays governed
      // by the sustain pedal, which continues to defer its sounding end.
      if (note.released === null) {
        note.released = tick;
        note.releasedMs = milliseconds;
        note.heldMs = round(milliseconds - note.pressedMs);
        note.releaseReason = reason;
        note.releaseKnown = true;
        note.releaseSource = {
          tick, timeMs: milliseconds, reason,
          track: source?.track ?? null, index: source?.index ?? null,
        };
        note.terminatedBy = reason;
        note.terminatedAt = { tick, timeMs: milliseconds, track: source?.track ?? null };
      }
      if (state.pedalDown) {
        if (note.soundingUntil === null) {
          note.sustainPending = true;
          note.pendingEndReason = 'sustain-pedal-up';
        }
      } else if (note.soundingUntil === null) {
        endSounding(note, tick, milliseconds, reason, source);
      }
    }
    if (reason === 'all-notes-off') {
      // The controller itself released these keys. Later explicit note-offs for
      // them have no pressed note left and are recorded as unmatched instead of
      // being silently absorbed.
      active.delete(state.channel);
    }
  };

  for (const event of parsed.events) {
    if (event.channel === undefined) continue;
    const state = channelState(event.channel);
    const { tick, timeMs: milliseconds } = event;

    if (event.type === 'programChange') {
      state.program = event.program;
      state.programs.push({
        program: event.program, tick, timeMs: milliseconds,
        track: event.track, index: event.index, sequence: event.sequence,
      });
      continue;
    }

    if (event.type === 'controlChange') {
      const previousPedal = state.pedalDown;
      state.controllers[event.controller] = event.value;
      state.controllerChanges.push({
        controller: event.controller, value: event.value, tick, timeMs: milliseconds,
        track: event.track, index: event.index, sequence: event.sequence,
      });
      if (event.controller === 64) {
        const down = event.value >= 64;
        if (previousPedal && !down) closeHeld(state, tick, milliseconds, 'sustain-pedal-up', event);
        state.pedalDown = down;
        state.pedalValue = event.value;
      } else if (event.controller === 120) {
        terminateChannel(state, tick, milliseconds, 'all-sound-off', event);
      } else if (event.controller === 123) {
        terminateChannel(state, tick, milliseconds, 'all-notes-off', event);
      } else if (event.controller === 121) {
        const wasDown = state.pedalDown;
        state.controllers = {};
        state.pedalDown = false;
        state.pedalValue = null;
        if (wasDown) closeHeld(state, tick, milliseconds, 'reset-all-controllers', event);
      }
      continue;
    }

    if (event.type === 'noteOn') {
      noteCounter += 1;
      const note = {
        id: `note-${noteCounter}`,
        pitch: event.pitch,
        note: event.pitch,
        velocity: event.velocity,
        channel: event.channel,
        track: event.track,
        trackIndex: event.track,
        part: event.track,
        trackName: parsed.tracks[event.track]?.name ?? null,
        pressed: tick,
        pressedMs: milliseconds,
        released: null,
        releasedMs: null,
        heldMs: null,
        soundingUntil: null,
        soundingUntilMs: null,
        soundingDurationMs: null,
        durationMs: null,
        endReason: null,
        releaseReason: null,
        terminatedBy: null,
        terminatedAt: null,
        program: state.program,
        programAtPress: state.program,
        instrument: state.program,
        sustainAtPress: state.pedalDown,
        pedalAtPress: state.pedalDown,
        controllersAtPress: { ...state.controllers },
        sustainPending: false,
        pendingEndReason: null,
        openAtSourceEnd: false,
        boundaryUncertain: false,
        releaseKnown: false,
        soundingEndKnown: false,
        intervalComplete: false,
        complete: false,
        noteOn: {
          sequence: event.sequence, track: event.track, index: event.index,
          tick, timeMs: milliseconds,
        },
        noteOff: null,
        pairing: null,
      };
      notes.push(note);
      queueFor(event.channel, event.pitch).push(note);
      sounding.add(note);
      state.noteOns += 1;
      event.noteId = note.id;
      continue;
    }

    if (event.type === 'noteOff') {
      const queue = active.get(event.channel)?.get(event.pitch);
      if (!queue || queue.length === 0) {
        const unmatched = {
          channel: event.channel,
          pitch: event.pitch,
          note: event.pitch,
          releaseVelocity: event.releaseVelocity ?? event.velocity,
          tick,
          timeMs: milliseconds,
          track: event.track,
          index: event.index,
          sequence: event.sequence,
          reason: 'no-pressed-note',
        };
        unmatchedNoteOffs.push(unmatched);
        state.unmatchedNoteOffs += 1;
        event.unmatched = true;
        event.unmatchedReason = 'no-pressed-note';
        diagnostic(diagnostics, 'unmatched-note-off', '松键没有对应的按下音符，保留为未匹配事件', {
          channel: event.channel, pitch: event.pitch, tick, track: event.track,
          index: event.index,
        });
        continue;
      }
      const candidates = queue.length;
      const note = queue.shift();
      if (queue.length === 0) active.get(event.channel).delete(event.pitch);
      note.released = tick;
      note.releasedMs = milliseconds;
      note.heldMs = round(milliseconds - note.pressedMs);
      note.releaseReason = 'note-off';
      note.releaseKnown = true;
      note.noteOff = {
        sequence: event.sequence, track: event.track, index: event.index,
        tick, timeMs: milliseconds, velocity: event.releaseVelocity ?? event.velocity,
      };
      note.pairing = {
        method: 'fifo', candidates, ambiguous: candidates > 1,
        firstPressedAt: note.pressed,
        crossTrack: note.track !== event.track,
      };
      event.noteId = note.id;
      if (note.track !== event.track) {
        diagnostic(diagnostics, 'cross-track-note-pairing',
          '松键与按下事件不在同一轨，按通道与音高配对', {
            channel: event.channel, pitch: event.pitch, tick,
            pressedTrack: note.track, releasedTrack: event.track, chosen: note.id,
          });
      }
      if (candidates > 1) {
        const ambiguity = {
          kind: 'note-pairing',
          noteId: note.id,
          channel: event.channel,
          pitch: event.pitch,
          tick,
          candidates,
          method: 'fifo',
        };
        ambiguities.push(ambiguity);
        diagnostic(diagnostics, 'ambiguous-note-pairing',
          '同通道同音高有多个按下音符，按先进先出配对并保留歧义记录', {
            channel: event.channel, pitch: event.pitch, tick,
            chosen: note.id, candidates,
          });
      }
      state.noteOffs += 1;
      if (state.pedalDown) {
        note.sustainPending = true;
        note.pendingEndReason = 'sustain-pedal-up';
      } else {
        endSounding(note, tick, milliseconds, 'note-off', event);
      }
    }
  }

  for (const track of parsed.tracks) {
    for (const note of notes) {
      if (note.track !== track.index) continue;
      const releasedInsideTrack = note.noteOff !== null && note.noteOff.tick <= track.endTick;
      if (releasedInsideTrack) continue;
      note.trackEndedBeforeNoteOff = true;
      note.trackEnd = {
        tick: track.endTick,
        endOfTrack: track.endOfTrack,
        complete: track.complete,
        releasedInTrack: false,
      };
      diagnostic(diagnostics, 'track-ended-before-note-off',
        '按下音符所在轨道结束时没有对应松键，轨道末端单独记录', {
          noteId: note.id, channel: note.channel, pitch: note.pitch,
          pressed: note.pressed, track: track.index, trackEndTick: track.endTick,
          endOfTrack: track.endOfTrack,
        }, track.complete ? 'warning' : 'error');
    }
  }

  for (const note of notes) {
    if (note.released === null && note.terminatedBy !== 'all-sound-off') {
      note.released = parsed.durationTicks;
      note.releasedMs = parsed.durationMs;
      note.heldMs = round(parsed.durationMs - note.pressedMs);
      note.releaseReason = 'source-end';
      note.releaseKnown = false;
      note.releaseSource = {
        tick: parsed.durationTicks, timeMs: parsed.durationMs,
        reason: 'source-end', track: null, index: null,
      };
    }
    if (note.released === null) {
      unresolvedReleases.push({
        noteId: note.id,
        channel: note.channel,
        pitch: note.pitch,
        cause: 'all-sound-off',
        tick: note.terminatedAt.tick,
        timeMs: note.terminatedAt.timeMs,
        detail: '全部声音停止只说明输出被静音，未说明按键何时松开',
      });
      diagnostic(diagnostics, 'release-unresolved-all-sound-off',
        '全部声音停止结束了发声，但没有提供可确定的松键时刻', {
          noteId: note.id, channel: note.channel, pitch: note.pitch,
          tick: note.terminatedAt.tick,
        }, parsed.complete ? 'warning' : 'error');
    } else if (note.releaseReason === 'source-end') {
      unresolvedReleases.push({
        noteId: note.id,
        channel: note.channel,
        pitch: note.pitch,
        cause: 'source-end',
        tick: parsed.durationTicks,
        timeMs: parsed.durationMs,
        detail: '资料在松键之前结束，末端只是可确定的边界',
      });
      diagnostic(diagnostics, 'release-unresolved-source-end',
        '松键未出现在资料中，释放边界取来源可确定的末端', {
          noteId: note.id, channel: note.channel, pitch: note.pitch,
          tick: note.pressed, boundaryTick: parsed.durationTicks,
          sourceComplete: parsed.complete,
        }, parsed.complete ? 'warning' : 'error');
    }
    if (note.soundingUntil !== null) continue;
    // The key was released while the pedal was down; the pedal never came up
    // inside the source, so only the source boundary is knowable.
    note.endReason = note.sustainPending ? 'sustain-pedal-unreleased' : 'source-end';
    note.soundingUntil = parsed.durationTicks;
    note.soundingUntilMs = parsed.durationMs;
    note.soundingDurationMs = round(parsed.durationMs - note.pressedMs);
    note.soundingEnd = {
      tick: parsed.durationTicks, timeMs: parsed.durationMs, reason: note.endReason,
      track: null, index: null,
    };
    note.openAtSourceEnd = true;
    note.boundaryUncertain = true;
    note.sustainPending = false;
    note.soundingEndKnown = false;
    diagnostic(diagnostics, 'open-note-at-source-end',
      '音符在资料末端仍未结束，发声边界取来源可确定的末端', {
        noteId: note.id, channel: note.channel, pitch: note.pitch, tick: note.pressed,
        boundaryTick: parsed.durationTicks, sourceComplete: parsed.complete,
      }, parsed.complete ? 'warning' : 'error');
  }

  for (const note of notes) {
    note.releaseKnown = note.released !== null && note.releaseReason !== 'source-end';
    note.soundingEndKnown = note.soundingUntil !== null && !note.boundaryUncertain;
    note.intervalComplete = note.soundingEndKnown;
    note.complete = note.intervalComplete && note.releaseKnown;
    note.durationMs = note.soundingDurationMs;
  }

  const channels = [...channelStates.values()]
    .sort((left, right) => left.channel - right.channel)
    .map(state => ({
      channel: state.channel,
      program: state.program,
      instrument: state.program,
      pedalDown: state.pedalDown,
      pedalValue: state.pedalValue,
      controllers: { ...state.controllers },
      programs: state.programs,
      controllerChanges: state.controllerChanges,
      noteOns: state.noteOns,
      noteOffs: state.noteOffs,
      unmatchedNoteOffs: state.unmatchedNoteOffs,
      activeNotesAtEnd: notes
        .filter(note => note.channel === state.channel && note.openAtSourceEnd)
        .map(note => note.id),
    }));

  const openNotes = notes.filter(note => note.openAtSourceEnd);
  const intervalsComplete = parsed.complete
    && notes.every(note => note.releaseKnown && note.soundingEndKnown);
  const performanceComplete = intervalsComplete
    && unmatchedNoteOffs.length === 0
    && unresolvedReleases.length === 0;
  const performanceCertain = performanceComplete
    && ambiguities.length === 0;

  return {
    notes, channels, unmatchedNoteOffs, openNotes, ambiguities, unresolvedReleases,
    intervalsComplete, performanceComplete, performanceCertain,
  };
}

export function parseMidi(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const diagnostics = [];

  if (bytes.length < 4 || bytes.toString('latin1', 0, 4) !== 'MThd') {
    throw new MidiError('不是 Standard MIDI File：缺少 MThd 头', 'NOT_MIDI', {
      byteLength: bytes.length,
    });
  }
  if (bytes.length < 8) {
    diagnostic(diagnostics, 'truncated-header', '文件在头部长度字段前结束', {
      byteOffset: bytes.length,
    }, 'error');
    return emptyResult(bytes, diagnostics);
  }

  const headerLength = bytes.readUInt32BE(4);
  const headerAvailable = Math.max(0, Math.min(headerLength, bytes.length - 8));
  if (headerAvailable < 6) {
    diagnostic(diagnostics, 'truncated-header', '文件头不足 6 字节，无法读出格式与时间基准', {
      headerLength, available: headerAvailable,
    }, 'error');
    return emptyResult(bytes, diagnostics);
  }
  if (headerLength < 6) {
    diagnostic(diagnostics, 'invalid-header-length', '文件头长度小于 6 字节', {
      headerLength,
    }, 'error');
  } else if (headerLength > headerAvailable) {
    diagnostic(diagnostics, 'truncated-header', '文件头长度超过实际字节', {
      headerLength, available: headerAvailable,
    }, 'error');
  }

  const format = bytes.readUInt16BE(8);
  const declaredTrackCount = bytes.readUInt16BE(10);
  const division = bytes.readUInt16BE(12);

  if ((division & 0x8000) !== 0) {
    throw new MidiError('暂不支持 SMPTE 时间基准，请提供 PPQN division', 'UNSUPPORTED_DIVISION', {
      division,
    });
  }
  if (division === 0) {
    throw new MidiError('division 为 0，无法换算时间', 'INVALID_DIVISION', { division });
  }
  if (format === 2) {
    throw new MidiError('暂不支持 format 2 演奏文件', 'UNSUPPORTED_FORMAT', { format });
  }
  if (format !== 0 && format !== 1) {
    diagnostic(diagnostics, 'unsupported-format', '只定义了 format 0/1 的解析行为', { format }, 'error');
  }
  if (format === 0 && declaredTrackCount !== 1) {
    diagnostic(diagnostics, 'format-track-mismatch', 'format 0 应只包含一个轨道', {
      format, declaredTrackCount,
    }, 'warning');
  }

  const tracks = [];
  let offset = 8 + headerLength;
  if (offset > bytes.length) {
    diagnostic(diagnostics, 'missing-track-data', '文件头之后没有轨道字节', {
      offset, byteLength: bytes.length,
    }, 'error');
  }

  while (offset < bytes.length) {
    if (bytes.length - offset < 8) {
      diagnostic(diagnostics, 'truncated-chunk-header', '轨道头不足 8 字节', {
        byteOffset: offset, remaining: bytes.length - offset,
      }, 'error');
      break;
    }
    const id = bytes.toString('latin1', offset, offset + 4);
    const declaredLength = bytes.readUInt32BE(offset + 4);
    const bodyStart = offset + 8;
    const declaredEnd = bodyStart + declaredLength;
    if (id !== 'MTrk') {
      diagnostic(diagnostics, 'unexpected-chunk', '文件包含非 MTrk 区块，已跳过其声明长度', {
        byteOffset: offset, id, declaredLength,
      }, 'warning');
      if (declaredEnd > bytes.length) {
        diagnostic(diagnostics, 'truncated-chunk', '非轨道区块的声明长度超过文件末尾', {
          byteOffset: offset, id, declaredLength, available: bytes.length - bodyStart,
        }, 'error');
        break;
      }
      offset = declaredEnd;
      continue;
    }
    const bodyEnd = Math.min(declaredEnd, bytes.length);
    tracks.push(parseTrack(bytes, {
      trackIndex: tracks.length,
      bodyStart,
      bodyEnd,
      declaredEnd,
      diagnostics,
    }));
    if (declaredEnd > bytes.length) break;
    offset = declaredEnd;
  }

  if (tracks.length !== declaredTrackCount) {
    diagnostic(diagnostics, 'track-count-mismatch', '文件头声明的轨道数与实际不同', {
      declaredTrackCount, parsedTrackCount: tracks.length,
    }, 'error');
  }

  const events = [];
  let fileOrder = 0;
  for (const track of tracks) {
    for (const event of track.events) {
      event.fileOrder = fileOrder;
      fileOrder += 1;
      events.push(event);
    }
  }
  events.sort((left, right) => left.tick - right.tick
    || left.track - right.track
    || left.index - right.index);
  events.forEach((event, sequence) => { event.sequence = sequence; });
  const rawEvents = [...events].sort((left, right) => left.fileOrder - right.fileOrder);

  const durationTicks = tracks.reduce(
    (maximum, track) => Math.max(maximum, track.lastCompleteTick), 0,
  );
  const lastReachedTick = tracks.reduce(
    (maximum, track) => Math.max(maximum, track.lastReachedTick), 0,
  );
  const { tempoMap, durationMs } = buildTimeline(events, division, durationTicks);

  const sawTruncation = diagnostics.some(item => item.code.startsWith('truncated'))
    || tracks.some(track => track.truncated);
  const structuralErrors = diagnostics.filter(item => item.severity === 'error');
  const complete = tracks.length === declaredTrackCount
    && tracks.every(track => track.complete)
    && structuralErrors.length === 0;

  const parsed = {
    format,
    trackCount: declaredTrackCount,
    parsedTrackCount: tracks.length,
    division,
    ticksPerQuarter: division,
    timing: 'ppqn',
    complete,
    truncated: sawTruncation,
    durationTicks,
    lastReachedTick,
    durationMs,
    durationBoundary: {
      tick: durationTicks,
      timeMs: durationMs,
      lastReachedTick,
      basis: sawTruncation ? 'truncated-source-end' : 'last-complete-event',
    },
    tempoMap,
    events,
    rawEvents,
    tracks,
    ordering: {
      events: 'tick, then track, then track-local index',
      rawEvents: 'file order: track order, then track-local index',
      sameTickAcrossTracks: 'track/index is preserved as evidence; no source order is invented',
    },
    byteLength: bytes.length,
  };
  Object.assign(parsed, interpret(parsed, diagnostics));
  parsed.diagnostics = diagnostics;
  parsed.counts = {
    tracks: tracks.length,
    events: events.length,
    notes: parsed.notes.length,
    unmatchedNoteOffs: parsed.unmatchedNoteOffs.length,
    openNotes: parsed.openNotes.length,
    unresolvedReleases: parsed.unresolvedReleases.length,
    ambiguities: parsed.ambiguities.length,
    diagnostics: diagnostics.length,
  };
  return parsed;
}

export const parseMidiFile = parseMidi;
export const parsePerformance = parseMidi;
export const analyzeMidi = parseMidi;
