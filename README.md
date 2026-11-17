# 演奏记录的跨轨道声部与踏板事件采集

这是面向资料接收人员的 Node.js 服务。提供人工收件、原始字节保管、业务身份版本记录和收件查询；同时支持自动来源接入：服务直接接收多轨 Standard MIDI File 演奏资料，在服务端完成跨轨道声部与踏板事件解释，原始事件顺序与可解释音符区间同时归档，不转换成乐谱、不重新播放。本地来源独立提供合作方交互环境。

## 环境

支持 Node.js 22.22.1 及以上的 22.x 补丁版本；项目 Dockerfile 仍固定原有镜像摘要以保证可复现，正式 Linux 基线另外在 Node.js 22.23.4 验证。运行期没有第三方包及公网数据依赖。`npm ci --ignore-scripts --no-audit --no-fund` 安装锁定环境，`npm run build` 检查所有模块语法，`npm test` 验证归档、SMF 解析解释、HTTP 入口及来源行为。来源材料均为本地合成的业务样本，没有真实账号、个人材料或访问外部站点的要求。

`npm start` 同时启动收件服务 3200 和来源 4200；可分别通过 `PORT`、`SOURCE_PORT` 修改端口。`ARCHIVE_DIR` 指定收件目录，默认 `.local/archive`。`npm run demo` 使用临时目录和系统分配端口展示人工收件、自动直投、来源拉取与截断交付，结束即清理，通常只需数秒。

## 容器

`docker build -t performance-events:local .` 构建环境，`docker run --rm -p 3200:3200 -p 4200:4200 performance-events:local` 启动。环境准备后，`docker run --rm --network none performance-events:local sh -c 'npm run build && npm test && npm run demo'` 可离线检查全部功能。正式展示应从干净归档启动真实新增功能并展示当前输出，完整操作限时 90 秒；准备镜像不计入运行时间。

## 接口与目录

`POST /api/manual` 接收 `fixtures/manual.json` 同形的业务对象，`GET /api/records` 查询全部收件版本（含人工与自动两个来源），`GET /health` 检查进程。人工记录身份字段为 recording, channel, pitch, pressed。归档目录有按摘要保存的 blobs 和按业务身份保存的 receipts。

`POST /api/collect` 接收自动采集的多轨演奏资料，支持三种投递：

- 原始 SMF 字节直投（`content-type: audio/midi`，recording 可放 `x-recording` 头）；
- JSON 封装 `{ "recording": "...", "data": "<Base64>" }`；
- 来源拉取 `{ "sourceUrl": "http://来源地址" }`，服务自行探查 `/performances` 并按相对链接逐份取回。

归档的自动记录包含：全局 tick 顺序的原始事件（含原始字节、track/index 证据与按 tempo 换算的微秒/毫秒）、按通道理解的乐器与控制器状态、可解释音符区间（pressed 按下、released 松键、sounding 发声结束三段时间）。延音踏板 CC64 使松键与发声结束分离；同音高叠键按 FIFO 配对并标注歧义；CC120/CC123 全部停止、轨道提前结束、文件截断、无匹配松键、缺失轨道等情况都在 `anomalies` 与 `complete` 中明确留痕，推断边界标 `inferredEnd`，不补造事件。协议范围、解析分层与异常代码见 `docs/source-contract.md`。

`src/` 为收件与传输，其中 `src/midi/` 为 SMF 解析（parse）、时间换算（timing）与通道解释（interpret）；`provider/` 为独立来源服务，`fixtures/` 保留来源字节与人工记录，`test/` 验证现有行为。
