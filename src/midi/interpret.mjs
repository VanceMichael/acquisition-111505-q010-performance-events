// 通道级演奏解释：跨轨共享同一通道状态，还原“按下—松键—发声结束”三类可解释区间。
// 松键与发声结束由延音踏板区分；同音高叠键按 FIFO 配对并保留歧义证据；
// 全部停止、轨道提前结束、文件截断等只记录来源能确定的边界，未确定的部分明确标注。

const SUSTAIN_CONTROLLER = 64;
const ALL_SOUND_OFF = 120;
const ALL_NOTES_OFF = 123;

function channelState() {
  return {
    program: null,
    sustainDown: false,
    // pitch -> 尚未收到松键的音符（FIFO 队列）
    active: new Map(),
    // 已松键但踏板仍踩下、仍在发声的音符
    sustained: new Set(),
    // pitch -> 全部叠键实例，供结果输出
    stacks: new Map(),
    controllers: new Map(),
    sustainIntervals: [],
  };
}

function eventRef(event) {
  return { track: event.track, order: event.order, tick: event.tick, ...event.time };
}

export function interpret(timing, parsed) {
  const channels = new Map();
  const notes = [];
  const anomalies = [];
  const stateOf = channel => {
    let state = channels.get(channel);
    if (!state) { state = channelState(); channels.set(channel, state); }
    return state;
  };
  const report = (code, message, extra = {}) => anomalies.push({ code, ...extra, message });
  const truncatedTracks = new Set(parsed.tracks.filter(track => track.truncated).map(track => track.index));
  // 整个轨道缺失意味着跨轨通道状态（如另一轨的踏板）来源不完整，相关结论只能标注为推断。
  const missingTracks = parsed.anomalies.some(item => item.code === 'missing-track');
  const fileEndTick = parsed.events.reduce((max, event) => Math.max(max, event.tick), 0);
  const fileEnd = timing.stamp(fileEndTick);

  function closeNote(note, event, reason, inferred) {
    note.sounding.end = eventRef(event);
    note.endReason = reason;
    note.inferredEnd = inferred;
  }

  function releaseNote(channel, pitch, event, via) {
    const state = stateOf(channel);
    const queue = state.active.get(pitch);
    if (!queue || queue.length === 0) {
      // 无匹配松键：保留事件证据，不伪造音符。
      report('orphan-note-off', `通道 ${channel} 音高 ${pitch} 的松键没有匹配的按下`, {
        channel, pitch, event: eventRef(event), via,
      });
      return;
    }
    const ambiguous = queue.length > 1;
    const note = queue.shift();
    note.released = { ...eventRef(event), via };
    if (ambiguous) {
      note.ambiguousMatch = true;
      report('ambiguous-match', `通道 ${channel} 音高 ${pitch} 存在 ${queue.length + 1} 个叠键，松键按 FIFO 归属最早按下者`, {
        channel, pitch, event: eventRef(event), noteId: note.id, candidates: queue.length + 1,
      });
    }
    if (state.sustainDown) {
      state.sustained.add(note);
    } else {
      closeNote(note, event, 'note-off', false);
    }
  }

  function liftSustain(state, event) {
    for (const note of state.sustained) closeNote(note, event, 'sustain-release', false);
    state.sustained.clear();
  }

  function stopAll(state, event, code, respectsSustain) {
    for (const [pitch, queue] of state.active) {
      for (const note of queue) {
        if (note.released === null) {
          report('note-off-missing', `通道 ${note.channel} 音高 ${pitch} 未收到松键，由 ${code} 确定发声边界`, {
            channel: note.channel, pitch, event: eventRef(event), noteId: note.id, stop: code,
          });
        }
        if (respectsSustain && state.sustainDown) {
          state.sustained.add(note);
        } else {
          closeNote(note, event, code, false);
        }
      }
    }
    state.active.clear();
    if (!respectsSustain) {
      for (const note of state.sustained) closeNote(note, event, code, false);
      state.sustained.clear();
    }
  }

  for (const event of timing.timeline) {
    if (event.type === 'program-change') {
      stateOf(event.channel).program = event.program;
      continue;
    }
    if (event.type === 'control-change') {
      const state = stateOf(event.channel);
      const previous = state.controllers.get(event.controller);
      state.controllers.set(event.controller, { value: event.value, since: eventRef(event), previous: previous?.value ?? null });
      if (event.controller === SUSTAIN_CONTROLLER) {
        const down = event.value >= 64;
        if (down && !state.sustainDown) {
          state.sustainDown = true;
          state.sustainIntervals.push({ start: eventRef(event), end: null, open: true });
        } else if (!down && state.sustainDown) {
          state.sustainDown = false;
          const interval = state.sustainIntervals[state.sustainIntervals.length - 1];
          interval.end = eventRef(event);
          interval.open = false;
          liftSustain(state, event);
        }
      } else if (event.controller === ALL_SOUND_OFF) {
        report('all-sound-off', `通道 ${event.channel} 收到 all-sound-off，立即结束该通道全部发声`, { channel: event.channel, event: eventRef(event) });
        stopAll(state, event, 'all-sound-off', false);
      } else if (event.controller === ALL_NOTES_OFF) {
        report('all-notes-off', `通道 ${event.channel} 收到 all-notes-off，延音中的音符仍受踏板约束`, { channel: event.channel, event: eventRef(event) });
        stopAll(state, event, 'all-notes-off', true);
      }
      continue;
    }
    if (event.type === 'note-on') {
      const state = stateOf(event.channel);
      if (!state.active.has(event.pitch)) state.active.set(event.pitch, []);
      if (!state.stacks.has(event.pitch)) state.stacks.set(event.pitch, []);
      const note = {
        id: `n${notes.length + 1}`,
        channel: event.channel,
        pitch: event.pitch,
        velocity: event.velocity,
        program: state.program,
        pressed: eventRef(event),
        released: null,
        sounding: { start: eventRef(event), end: null },
        endReason: null,
        inferredEnd: false,
        ambiguousMatch: false,
      };
      state.active.get(event.pitch).push(note);
      state.stacks.get(event.pitch).push(note);
      notes.push(note);
      continue;
    }
    if (event.type === 'note-on-zero') {
      releaseNote(event.channel, event.pitch, event, 'note-on-velocity-zero');
      continue;
    }
    if (event.type === 'note-off') {
      releaseNote(event.channel, event.pitch, event, 'note-off');
      continue;
    }
    if (event.type === 'end-of-track') {
      // 轨道提前结束：只结束来源本轨按下且仍未配对的音符，边界来自该轨 EOT，属于可推断而非真实松键。
      for (const [channel, state] of channels) {
        for (const [pitch, queue] of state.active) {
          const remaining = [];
          for (const note of queue) {
            if (note.pressed.track !== event.track) { remaining.push(note); continue; }
            report('note-off-missing', `轨道 ${event.track} 提前结束，通道 ${channel} 音高 ${pitch} 未收到松键`, {
              channel, pitch, event: eventRef(event), noteId: note.id, stop: 'track-end',
            });
            closeNote(note, event, 'track-end', true);
            state.sustained.delete(note);
          }
          if (remaining.length) state.active.set(pitch, remaining);
          else state.active.delete(pitch);
        }
      }
    }
  }

  // 文件结束或截断后仍未确定发声结束的音符：只记录来源能确定的最后边界。
  for (const note of notes) {
    if (note.sounding.end !== null) continue;
    const reason = truncatedTracks.has(note.pressed.track) ? 'truncated' : 'end-of-file';
    note.sounding.end = { ...fileEnd, inferred: true };
    note.endReason = reason;
    note.inferredEnd = true;
    report('unclosed-note', `通道 ${note.channel} 音高 ${note.pitch} 在${reason === 'truncated' ? '截断处' : '文件结束处'}仍无确定的发声结束`, {
      channel: note.channel, pitch: note.pitch, noteId: note.id, boundary: reason, pressed: note.pressed,
    });
  }
  for (const state of channels.values()) {
    for (const interval of state.sustainIntervals) {
      if (interval.open) { interval.end = { ...fileEnd, inferred: true }; interval.inferredEnd = true; }
    }
  }

  // 缺失整轨时，跨轨共享的通道状态不再完整：已“闭合”的发声结束也缺来源佐证，回退为文件边界推断。
  if (missingTracks) {
    for (const note of notes) {
      if (note.inferredEnd) continue;
      report('uncertain-end', `文件缺失声明轨道，通道 ${note.channel} 的跨轨状态不完整，音符 ${note.id} 的发声结束无法被来源证实`, {
        channel: note.channel, pitch: note.pitch, noteId: note.id, previousEnd: note.sounding.end,
      });
      note.sounding.end = { ...fileEnd, inferred: true };
      note.endReason = 'missing-track';
      note.inferredEnd = true;
    }
    for (const state of channels.values()) {
      for (const interval of state.sustainIntervals) {
        if (!interval.inferredEnd) { interval.end = { ...fileEnd, inferred: true }; interval.inferredEnd = true; interval.uncertain = true; }
      }
    }
  }

  const channelOutput = {};
  for (const [channel, state] of [...channels.entries()].sort((a, b) => a[0] - b[0])) {
    const controllers = {};
    for (const [controller, entry] of [...state.controllers.entries()].sort((a, b) => a[0] - b[0])) {
      controllers[controller] = { value: entry.value, since: entry.since, previous: entry.previous };
    }
    channelOutput[channel] = {
      program: state.program,
      sustain: { down: state.sustainDown },
      controllers,
      sustainIntervals: state.sustainIntervals,
      pitches: [...state.stacks.keys()].sort((a, b) => a - b),
    };
  }

  return {
    notes,
    channels: channelOutput,
    anomalies,
    boundaries: { fileEnd, truncatedTracks: [...truncatedTracks].sort((a, b) => a - b), missingTracks },
  };
}
