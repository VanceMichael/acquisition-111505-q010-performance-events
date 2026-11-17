# 合作来源约定

## 资料边界

交付为 Standard MIDI File format 0/1 子集，MThd/MTrk、VLQ delta、running status、note on/off、control change、program change、tempo meta、end-of-track；division 支持 PPQN，SMPTE division 明确报不支持而非套 PPQN。同 tick 事件保留 track/index 排序证据，不跨轨臆造先后。sustain=CC64，all-notes-off=123，all-sound-off=120。tempo 作用于整份文件。

## 本地服务

来源和收件端是两个独立 HTTP 监听器。来源 `/health` 报告运行状态，`/__state` 返回当前情景；仅本地使用的 `POST /__control` 可改变来源情景，不属于收件端的业务 API。具体情景字段在 `provider/scenario.mjs` 的 `initialState` 中定义，切换只影响后续来源响应，不会改写已有收件。探查入口为 `/performances`，请求相对链接必须以实际来源地址解释。

## 已有归档约定

人工入口只接收人工确认过的结构化对象，并不验证自动来源完整性。`Archive.accept(source, identity, data, raw)` 把原始字节按摘要保存，并为同一来源与身份保留不同版本。`source` 和 `identity` 的选择必须与业务对象对应，正文摘要只用于原文复用，不代表两份业务记录相同。`src/transport.mjs` 仅提供一次请求，不包含自动分页、协议解释或领域恢复策略。

## 自动采集架构

自动采集由收件端 Node.js 服务直接完成，不再依赖人工摘要，分三层，全部在 `src/midi/` 内、无第三方依赖：

- `parse.mjs`：字节级 SMF 解析。逐条解码 VLQ delta 与 running status（running status 只在同一轨道内延续），保留每个事件的原始字节、轨道号与轨内序号。截断、缺 end-of-track、未知数据块、format 2、SMPTE division、非 MThd 等都产生带 `code` 的异常记录；除致命格式错误外，已解析事件仍保留。
- `timing.mjs`：把各轨事件合并成全局 tick 时间线，同 tick 按轨道号、轨内序号稳定排序；根据整份文件的 tempo meta 建立速度表，把 tick 换算为微秒与毫秒。无 tempo 时采用 500000µs/四分音符默认值。
- `interpret.mjs`：按 MIDI 通道维护跨轨共享状态（program、CC64 延音踏板、控制器取值），输出可解释音符区间。同音高叠键按 FIFO 配对，存在多个候选时给音符标 `ambiguousMatch` 并记录 `ambiguous-match` 异常；松键与发声结束是两个字段，踏板踩下时松键的音符进入延音集合，抬踏板（CC64<64）才统一结束。CC120 all-sound-off 立即结束发声，CC123 all-notes-off 仍尊重踏板。轨道 end-of-track 只推断本轨未配对音符的边界（`track-end`），文件截断标 `truncated`，文件正常结束仍开着的音符标 `end-of-file`，整个声明轨道缺失时相关结论回退为 `missing-track` 推断；无匹配松键记 `orphan-note-off`，不伪造音符。

`src/collect.mjs` 是采集应用层：`receivePerformance` 把原始字节与解释结果一并交给 `Archive`，来源标记为 `automatic`（来源拉取为 `automatic-pull`），与 `manual` 人工来源在同一归档中互不混淆；data 只含确定性分析结果，因此同原文重复投递可复用版本，接收时间由归档层记录。`pullPerformances` 先请求 `/performances` 清单，再把每条 `href` 以实际来源地址解释后逐份拉取。

## 自动采集 HTTP 约定

`POST /api/collect` 支持三种投递，成功返回 201 并给收据；解析到致命格式错误返回 422，JSON 封装格式错误返回 400，请求体超过 16MiB 返回 413：

- 原始字节：请求体即 SMF 字节，`content-type` 非 JSON 即可；业务身份 recording 可放在 `x-recording` 头，缺失时身份为 `{ recording: null }` 并照常归档。
- JSON 封装：`{ "recording": "lesson-1", "data": "<Base64 SMF>" }`。
- 来源拉取：`{ "sourceUrl": "http://来源地址", "probe": "/performances" }`，probe 可省略，缺省取 `fixtures/project.json`。

返回结果同时包含原始事件顺序（`events`，带 tick/微秒/毫秒与原始字节）和可解释音符区间（`notes`，含 pressed、released、sounding 三段时间与结束原因），`complete` 与 `anomalies` 明确暴露不完整、无匹配松键和无法确定归属的情况，不修饰成完美演奏。
