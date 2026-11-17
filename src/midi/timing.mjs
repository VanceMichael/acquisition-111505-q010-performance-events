// 全局时间线：合轨排序与 tempo 换算。
// tempo meta 作用于整份文件；时间同时保留 tick 与按速度事件累计的微秒/毫秒，不直接写成乐谱节拍。

function buildTempoMap(events, defaultTempo) {
  const tempoEvents = events
    .filter(event => event.type === 'meta' && event.metaType === 0x51 && typeof event.tempo === 'number')
    .map(event => ({ tick: event.tick, usPerQuarter: event.tempo }));
  // 同 tick 的多个速度事件保留来源顺序，换算时取该 tick 上最后生效的一个。
  tempoEvents.sort((a, b) => a.tick - b.tick);
  const segments = [];
  let current = defaultTempo;
  if (tempoEvents.length === 0 || tempoEvents[0].tick > 0) segments.push({ tick: 0, usPerQuarter: defaultTempo });
  for (const event of tempoEvents) {
    const last = segments[segments.length - 1];
    if (last && last.tick === event.tick) last.usPerQuarter = event.usPerQuarter;
    else segments.push({ tick: event.tick, usPerQuarter: event.usPerQuarter });
    current = event.usPerQuarter;
  }
  return { defaultTempo, segments, lastTempo: current };
}

export function createTiming(events, { ppqn, defaultTempo }) {
  const tempoMap = buildTempoMap(events, defaultTempo);

  function tickToMicros(tick) {
    let micros = 0;
    for (let index = 0; index < tempoMap.segments.length; index += 1) {
      const segment = tempoMap.segments[index];
      if (tick < segment.tick) break;
      const next = tempoMap.segments[index + 1];
      const span = (next ? Math.min(tick, next.tick) : tick) - segment.tick;
      micros += (span * segment.usPerQuarter) / ppqn;
    }
    return micros;
  }

  const stamp = tick => {
    const micros = Math.round(tickToMicros(tick));
    return { tick, micros, millis: Math.round(micros / 1000) };
  };

  // 同 tick 事件保留 track/index 排序证据，不跨轨臆造先后。
  const timeline = events
    .map(event => ({ ...event, time: stamp(event.tick) }))
    .sort((a, b) => (a.tick - b.tick) || a.track - b.track || a.order - b.order);
  return {
    ppqn,
    tempoMap: tempoMap.segments,
    tickToMicros,
    stamp,
    timeline,
  };
}
