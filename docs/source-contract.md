# 合作来源约定

## 资料边界

交付为 Standard MIDI File format 0/1 子集，MThd/MTrk、VLQ delta、running status、note on/off、control change、program change、tempo meta、end-of-track；division 支持 PPQN，SMPTE division 明确报不支持而非套 PPQN。同 tick 事件保留 track/index 排序证据，不跨轨臆造先后。sustain=CC64，all-notes-off=123，all-sound-off=120。tempo 作用于整份文件。

## 时间

每个事件的绝对 tick 换算为毫秒时跟随此前最近的速度事件；文件起始没有速度事件时使用 MIDI 默认的 500000 µs/四分音符（120 BPM），并在 `tempoMap` 中标记 `default: true`。速度事件为 0、长度不是 3 字节或换算无法进行时，记录诊断而不用伪速度补写。所有时间同时保留 `tick` 与 `ms`，不对浮点毫秒做取整后回写 tick。

`durationTicks` 取各轨最后一条完整事件所在 tick 的最大值；截断或提前结束的轨道最后尝试读取的 tick 另记在 `lastReachedTick`，不把读了一半的事件算作边界。资料末端仍发声的音符标 `openAtSourceEnd` 与 `boundaryUncertain`，其边界取 `durationTicks` 而不是无限延伸。

## 通道与轨道

乐器（program change）与控制器（含 CC64）按 MIDI 通道解释，事件所在的轨道只是证据字段，不是作用域。同一通道的按下、松键、踏板和乐器事件即使分布在多个轨道也互相影响。同通道同音高可有多个同时按下的音符，松键按先进先出配对，并在 `pairing.candidates`、`ambiguities` 与诊断中保留歧义。松键与按下不在同一轨道时记录 `cross-track-note-pairing` 诊断。

## 音符区间

每条音符同时给出三组边界：

- `pressed` / `pressedMs`：按下键的时刻。
- `released` / `releasedMs`：松键时刻；来源未给出可确定值时 `releaseKnown: false`。
- `soundingUntil` / `soundingUntilMs`：实际发声结束时刻，`endReason` 说明来源依据。

延音踏板按下时，松键只把音符标记为等待踏板抬起；踏板抬起（CC64 < 64）才结束发声，`endReason` 为 `sustain-pedal-up`。若松键后踏板在资料内始终没有抬起，发声边界取资料末端并标 `sustain-pedal-unreleased`，同时保留 `boundaryUncertain`。踏板抬起前发生 all-notes-off 或 all-sound-off 时按各自语义处理：

- CC123 all-notes-off 释放仍按住的键；踏板仍按下时发声继续等待踏板抬起，否则立即结束。后续针对这些音符的显式松键因已无按下音符而进入 `unmatchedNoteOffs`。
- CC120 all-sound-off 立即结束发声，但不提供可确定的松键时刻，`releaseKnown: false`，并记入 `unresolvedReleases`。

没有匹配按下音符的松键不并入相邻音符，单独进入 `unmatchedNoteOffs`，对应事件标 `unmatched: true`。按下音符所在轨道先结束、而该音高尚未收到松键时，`trackEndedBeforeNoteOff` 与 `trackEnd` 记录轨道末端（含 `endOfTrack` 与轨道是否完整），并产生 `track-ended-before-note-off` 诊断；不把轨道结束当作松键。资料结束前既未松键也未终止的音符以资料末端为边界，记入 `openNotes` 与 `unresolvedReleases`，不假定它们自然结束。

## 顺序与完整性

`events` 按 tick、track、轨内 index 排序，用于解释通道状态；`rawEvents` 按文件中的轨道顺序与轨内 index 保留原始事件顺序。同 tick 跨轨事件只保留 track/index 证据，不声明来源未给出的先后。

`complete` 只表示文件结构与轨道结束事件完整；`intervalsComplete` 要求所有音符的松键与发声边界都可确定；`performanceComplete` 还要求没有未匹配松键与未决释放；`performanceCertain` 还要求没有同音高配对歧义。任何一层为 false 都如实保留，不修饰成完美演奏。所有不完整、截断、缺结束事件、非法速度、系统事件与配对歧义都进入 `diagnostics`，`severity` 区分 `warning` 与 `error`。

## 本地服务

来源和收件端是两个独立 HTTP 监听器。来源 `/health` 报告运行状态，`/__state` 返回当前情景；仅本地使用的 `POST /__control` 可改变来源情景，不属于收件端的业务 API。具体情景字段在 `provider/scenario.mjs` 的 `initialState` 中定义，切换只影响后续来源响应，不会改写已有收件。探查入口为 `/performances`，请求相对链接必须以实际来源地址解释。

## 归档约定

自动入口以原始 MIDI 字节为内容摘要，业务身份为 `{ recording }`。`recording` 依次取请求显式值、文件首个带名称的轨道名、按原始摘要生成的 `upload-<摘要前缀>`，不推断乐器或声部身份。同一来源与同一身份下原文相同复用版本，字节不同保留新版本。归档同时保存 `blobs`（原始字节）、`receipts`（按业务身份聚合的版本与可解释结果）。`Archive.accept(source, identity, data, raw)` 的选择必须与业务对象对应；正文摘要只用于原文复用，不代表两份业务记录相同。`src/transport.mjs` 仅提供一次请求，不包含自动分页、协议解释或领域恢复策略。
