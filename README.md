# 演奏记录的跨轨道声部与踏板事件采集

这是面向资料接收人员的 Node.js 服务。自动演奏设备交回的多轨 MIDI 演奏由 `POST /api/collect` 直接接收，服务解析速度事件、按通道解释乐器与控制器、跨轨配对松键并保留原始事件顺序；同时给出可解释的音符区间、未匹配松键、未决边界与完整性诊断。结果保留原始字节，不转换成乐谱，也不重新播放。既有人工收件入口继续可用，两者按来源区分，不会混淆。

## 环境

支持 Node.js 22.22.1 及以上的 22.x 补丁版本；项目 Dockerfile 仍固定原有镜像摘要以保证可复现，正式 Linux 基线另外在 Node.js 22.23.4 验证。运行期没有第三方包及公网数据依赖。`npm ci --ignore-scripts --no-audit --no-fund` 安装锁定环境，`npm run build` 检查所有模块语法，`npm test` 验证归档、HTTP 入口、来源行为、MIDI 解析与自动收件。来源材料均为本地合成的业务样本，没有真实账号、个人材料或访问外部站点的要求。

`npm start` 同时启动收件服务 3200 和来源 4200；可分别通过 `PORT`、`SOURCE_PORT` 修改端口，`SOURCE_URL` 指定收件端默认取件的来源地址（默认 `http://127.0.0.1:${SOURCE_PORT}`）。`ARCHIVE_DIR` 指定收件目录，默认 `.local/archive`。`npm run demo` 使用临时目录和系统分配端口展示人工收件、自动取回、音符检索以及截断交付的如实记录，结束即清理，通常只需数秒。

## 容器

`docker build -t performance-events:local .` 构建环境，`docker run --rm -p 3200:3200 -p 4200:4200 performance-events:local` 启动。环境准备后，`docker run --rm --network none performance-events:local sh -c 'npm run build && npm test && npm run demo'` 可离线检查现有功能。正式展示应从干净归档启动真实新增功能并展示当前输出，完整操作限时 90 秒；准备镜像不计入运行时间。

## 接口与目录

`POST /api/collect` 接收自动演奏资料，三种形式：

- `content-type: audio/midi`：请求体即 MIDI 字节；`X-Recording` 或 `?recording=` 指定业务身份。
- JSON 指令 `{ "source": "http://来源" }`：从来源探查入口取回列表，按列表项链接（相对链接按实际来源地址解释）逐个接收。
- JSON 指令 `{ "url": "http://…/x.mid", "recording": "…" }` 或 `{ "midi": "<base64>", "encoding": "base64" }`：直接接收单个演奏。

未带请求体与 JSON 时，若配置了 `SOURCE_URL` 则从该来源取件。单份 MIDI 上限 8 MiB。成功返回 201（部分列表项失败为 207），响应含收件标识、版本、原始摘要、`complete`、`performanceComplete`、`performanceCertain`、诊断与完整 `analysis`；非 MIDI 字节返回 415，SMPTE/format 2 等不支持的时间基准返回 422 并说明原因。截断文件仍被接收，但在 `analysis` 中标记不完整、未决边界与相应诊断，不会补写为完整演奏。

`GET /api/records` 查询全部收件，`GET /api/records/:receipt` 查询单份收件及版本，`GET /api/records/:receipt/:version` 查询某一版本的解析结果，`GET /api/records/:receipt/raw` 取回原始 MIDI 字节。`GET /api/notes` 按 `recording`、`channel`、`pitch`、`track`、`from`、`to`（毫秒）与 `complete` 检索实际按过的键，返回按下、松键、发声结束及各自是否可确定。

`POST /api/manual` 接收 `fixtures/manual.json` 同形的业务对象，`GET /health` 检查进程。人工记录身份字段为 recording, channel, pitch, pressed。同一身份与相同原文重复提交复用版本，内容变化保留旧版本；不同来源不能混淆。归档目录有按摘要保存的 blobs 和按业务身份保存的 receipts。

`src/midi.mjs` 为 MIDI 解析与音符解释，`src/intake.mjs` 为人工/自动收件与来源取件，`src/server.mjs` 为 HTTP 入口与检索，`provider/` 为独立来源服务，`fixtures/` 保留来源字节与人工记录，`test/` 验证现有行为。协议范围、时间换算、踏板与完整性约定见 `docs/source-contract.md`。
